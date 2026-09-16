import { buildPrompt, formatUserMessage } from '../acp/prompt-builder.js';
import { handleCommand } from '../commands/handlers.js';
import type { Lang } from '../commands/i18n.js';
import { parseSlashCommand } from '../commands/parser.js';
import type { MessageBus } from '../infra/message-bus.js';
import type { AcpClawConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { SessionManager } from '../session/manager.js';
import type { ControllerEvents } from '../types/events.js';
import type { EventBus } from '../infra/event-bus.js';
import { PromptPipeline } from '../pipeline/pipeline.js';
import { buildInitialContext, buildInitGuidance } from '../infra/context-builder.js';

export class MessageDispatcher {
  private eventBus: EventBus;
  private pipeline: PromptPipeline;
  private sessionManager: SessionManager;
  private messageBus: MessageBus;
  private config: AcpClawConfig;
  private workDir: string;
  private logger: Logger;
  private unsubscribes: Array<() => void> = [];

  constructor(params: {
    eventBus: EventBus;
    sessionManager: SessionManager;
    messageBus: MessageBus;
    config: AcpClawConfig;
    workDir: string;
    logger: Logger;
  }) {
    this.eventBus = params.eventBus;
    this.sessionManager = params.sessionManager;
    this.messageBus = params.messageBus;
    this.config = params.config;
    this.workDir = params.workDir;
    this.logger = params.logger;
    this.pipeline = new PromptPipeline(
      params.sessionManager,
      params.config,
      params.logger,
    );

    const unsub = this.eventBus.on('message-arrived', (payload) => {
      void this.handleMessage(payload);
    });
    this.unsubscribes.push(unsub);
  }

  destroy(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  private async handleMessage(
    payload: ControllerEvents['message-arrived'],
  ): Promise<void> {
    const { message: msg, sessionKey, userPrefix } = payload;

    // Determine output channel: scheduler messages may specify a sourceChannel
    const outputChannel = (msg.raw as any)?.sourceChannel || payload.channel;

    // Check for slash command
    const command = parseSlashCommand(msg.content);
    if (command) {
      const session = this.sessionManager.getSession(sessionKey);
      const isBusy = session?.busy ?? false;
      const result = await handleCommand(command.name, command.args, {
        sessionKey,
        userPrefix,
        sessionManager: this.sessionManager,
        config: this.config,
        isBusy,
        workDir: this.workDir,
        language: (this.config.language ?? 'zh') as Lang,
      });
      if (msg.id) {
        await this.messageBus.publish({
          channelName: outputChannel,
          messageId: msg.id,
          type: 'text',
          content: result.text,
        });
      } else if (msg.chatId) {
        await this.messageBus.publish({
          channelName: outputChannel,
          chatId: msg.chatId,
          type: 'text',
          content: result.text,
        });
      }
      return;
    }

    // Normal message processing
    try {
      let text = msg.content;

      if (payload.channel === 'feishu' && this.config.feishu?.appName) {
        text = text
          .replace(new RegExp(`@${this.config.feishu.appName}\\s*`), '')
          .trim();
      }

      const existingSession = this.sessionManager.getSession(sessionKey);
      if (existingSession?.busy) {
        console.log(
          `⚡ [interrupt] Cancelling current prompt on ${sessionKey}`,
        );
        await this.sessionManager.cancel(sessionKey);
      }

      // Ensure session exists, check if it's newly created
      const session = await this.sessionManager.getOrCreate(sessionKey);
      const isNewSession = session.isNew;

      let parts: ReturnType<typeof buildPrompt>;
      if (isNewSession) {
        const filePaths = buildInitialContext(this.workDir);
        const initGuidance = buildInitGuidance(this.workDir);
        const userMsg = formatUserMessage(payload.channel, msg.senderId, text);
        const promptText = initGuidance
          ? `${initGuidance}\n\n---\n\n${userMsg}`
          : userMsg;
        parts = buildPrompt(promptText, filePaths);
        session.isNew = false;
      } else {
        parts = buildPrompt(
          formatUserMessage(payload.channel, msg.senderId, text),
        );
      }

      // Log the prompt being sent
      const promptPreview =
        text.length > 200 ? text.slice(0, 200) + '...' : text;
      this.logger.info('prompt', `[${sessionKey}] ${promptPreview}`);

      // Execute via pipeline
      const expectReplay = session.expectReplay;
      if (expectReplay) {
        session.expectReplay = false; // 仅第一次 prompt 后 replay
      }
      const result = await this.pipeline.execute(sessionKey, parts, {
        onText: async (chunk) => {
          console.log(`📝 [agent] ${chunk}`);
          this.logger.info('agent-text-complete', chunk);
          if (msg.id) {
            await this.messageBus.publish({
              channelName: outputChannel,
              messageId: msg.id,
              type: 'text',
              content: chunk,
            });
          } else if (msg.chatId) {
            await this.messageBus.publish({
              channelName: outputChannel,
              chatId: msg.chatId,
              type: 'text',
              content: chunk,
            });
          }
        },
        onTool: async (toolLog) => {
          console.log(`🔧 [tool] ${toolLog}`);
          this.logger.info('agent-tool', `[${sessionKey}] ${toolLog}`);

          if (this.config.forwardToolMessages) {
            const toolMsg = `🔧 工具调用: ${toolLog}`;
            this.messageBus.publish({
              channelName: outputChannel,
              messageId: msg.id || undefined,
              chatId: msg.chatId,
              type: 'text',
              content: toolMsg,
            }).catch(() => {});
          }
        },
      }, { expectReplay });

      if (result.hasSentMessage && msg.id && payload.channel === 'feishu') {
        await this.messageBus.publish({
          channelName: 'feishu',
          messageId: msg.id,
          type: 'clear-reaction',
          content: '',
        });
      }

      // Send completion signal for A2A channel
      if (payload.channel === 'a2a') {
        await this.messageBus.publish({
          channelName: 'a2a',
          messageId: msg.id,
          chatId: msg.chatId,
          type: 'status-update',
          content: 'completed',
        });
      }

      // 一次性会话（cron --fresh-session）：本轮结束后销毁会话，
      // 避免上下文累积，也避免每天多留一个常驻 agent 进程
      if ((msg.raw as { freshSession?: boolean } | undefined)?.freshSession) {
        try {
          await this.sessionManager.close(sessionKey);
          this.logger.info(
            'session',
            `[${sessionKey}] fresh session closed after scheduled run`,
          );
        } catch (err) {
          this.logger.warn('session', `close ${sessionKey} failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Error handling message:`, errMsg);
      this.logger.error('error', `[${sessionKey}] ${errMsg}`);
      if (msg.id) {
        await this.messageBus.publish({
          channelName: outputChannel,
          messageId: msg.id,
          type: 'text',
          content: `❌ 处理失败: ${errMsg}`,
        });
      }
      // Ensure A2A SSE stream is closed on error
      if (payload.channel === 'a2a') {
        await this.messageBus.publish({
          channelName: 'a2a',
          messageId: msg.id,
          chatId: msg.chatId,
          type: 'status-update',
          content: 'completed',
        });
      }
    }
  }
}
