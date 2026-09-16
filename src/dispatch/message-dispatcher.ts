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
  /** sessionKey → 定时关闭的计时器（定时任务保留窗口） */
  private closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    for (const timer of this.closeTimers.values()) {
      clearTimeout(timer);
    }
    this.closeTimers.clear();
  }

  /**
   * 安排会话在 ttlMs 后关闭（重复调用会顺延）。
   * 用于「定时任务触发后仍保留一段时间」的场景。
   */
  private scheduleSessionClose(sessionKey: string, ttlMs: number): void {
    const existing = this.closeTimers.get(sessionKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.closeTimers.delete(sessionKey);
      void this.sessionManager
        .close(sessionKey)
        .then(() =>
          this.logger.info(
            'session',
            `[${sessionKey}] retention window ended, session closed`,
          ),
        )
        .catch((err) =>
          this.logger.warn('session', `close ${sessionKey} failed`, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }, ttlMs);
    timer.unref?.();
    this.closeTimers.set(sessionKey, timer);
    // 在保留窗口内保护该会话，避免被空闲回收提前关掉
    this.sessionManager.protectSession(sessionKey, Date.now() + ttlMs);
    this.logger.info(
      'session',
      `[${sessionKey}] kept alive for ${Math.round(ttlMs / 60000)}min after scheduled run`,
    );
  }

  /**
   * 定时任务等本地来源的 message id 是合成 id（如 scheduled_每日简报_123），
   * 不是飞书的 open_message_id，拿去调 reply 接口必然失败（99992354）。
   * 这里只把真正的远端消息 id 透传为 messageId，其余一律带 chatId 走直发。
   */
  private resolveReplyTarget(msg: { id?: string; chatId?: string }): {
    messageId?: string;
    chatId?: string;
  } {
    const id = msg.id;
    const isLocalSyntheticId =
      typeof id === 'string' && id.startsWith('scheduled_');
    return {
      messageId: id && !isLocalSyntheticId ? id : undefined,
      chatId: msg.chatId,
    };
  }

  /** 统一回复出口：失败写日志，避免消息静默丢失 */
  private async publishReply(
    channelName: string,
    msg: { id?: string; chatId?: string },
    content: string,
  ): Promise<void> {
    const target = this.resolveReplyTarget(msg);
    if (!target.messageId && !target.chatId) return;
    const result = await this.messageBus.publish({
      channelName,
      ...target,
      type: 'text',
      content,
    });
    if (!result.success) {
      this.logger.warn(
        'dispatch',
        `publish to "${channelName}" failed: ${result.error ?? 'unknown error'}`,
      );
    }
  }

  private async handleMessage(
    payload: ControllerEvents['message-arrived'],
  ): Promise<void> {
    const { message: msg, sessionKey, userPrefix } = payload;

    // Determine output channel: scheduler messages may specify a sourceChannel
    const outputChannel = (msg.raw as any)?.sourceChannel || payload.channel;
    const msgRaw = msg.raw as
      | {
          freshSession?: boolean;
          keepSessionMs?: number;
          agent?: string;
        }
      | undefined;

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

      // 附件（图片）提示：让模型知道后面跟着图片块
      const attachments = msg.files ?? [];
      if (attachments.length > 0) {
        text = `[附带 ${attachments.length} 张图片] ${text}`;
      }

      const existingSession = this.sessionManager.getSession(sessionKey);
      if (existingSession?.busy) {
        console.log(
          `⚡ [interrupt] Cancelling current prompt on ${sessionKey}`,
        );
        await this.sessionManager.cancel(sessionKey);
      }

      // Ensure session exists, check if it's newly created
      const session = await this.sessionManager.getOrCreate(
        sessionKey,
        msgRaw?.agent,
      );
      const isNewSession = session.isNew;

      let parts: ReturnType<typeof buildPrompt>;
      if (isNewSession) {
        const filePaths = buildInitialContext(this.workDir);
        const initGuidance = buildInitGuidance(this.workDir);
        const userMsg = formatUserMessage(payload.channel, msg.senderId, text);
        const promptText = initGuidance
          ? `${initGuidance}\n\n---\n\n${userMsg}`
          : userMsg;
        parts = buildPrompt(promptText, filePaths, attachments);
        session.isNew = false;
      } else {
        parts = buildPrompt(
          formatUserMessage(payload.channel, msg.senderId, text),
          undefined,
          attachments,
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
          await this.publishReply(outputChannel, msg, chunk);
        },
        onTool: async (toolLog) => {
          console.log(`🔧 [tool] ${toolLog}`);
          this.logger.info('agent-tool', `[${sessionKey}] ${toolLog}`);

          if (this.config.forwardToolMessages) {
            const toolMsg = `🔧 工具调用: ${toolLog}`;
            void this.publishReply(outputChannel, msg, toolMsg);
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

      // 定时任务的会话生命周期：
      // - freshSession：本轮结束后销毁（上下文不累积、进程不常驻）
      // - keepSessionMs：本轮结束后保留一段时间再关闭（期间用户可以在群里追问）
      if (msgRaw?.freshSession) {
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
      } else if (msgRaw?.keepSessionMs && msgRaw.keepSessionMs > 0) {
        this.scheduleSessionClose(sessionKey, msgRaw.keepSessionMs);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Error handling message:`, errMsg);
      this.logger.error('error', `[${sessionKey}] ${errMsg}`);
      if (msg.id) {
        await this.publishReply(outputChannel, msg, `❌ 处理失败: ${errMsg}`);
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
