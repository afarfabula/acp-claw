import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { A2AServerChannel } from '../channel/a2a.js';
import { FeishuChannel } from '../channel/feishu.js';
import { InjectChannel } from '../channel/inject.js';
import { SchedulerChannel } from '../channel/scheduler.js';
import type { AcpClawConfig } from '../config.js';
import { MessageDispatcher } from '../dispatch/message-dispatcher.js';
import { EventBus } from '../infra/event-bus.js';
import { MessageBus } from '../infra/message-bus.js';
import { createLogger, type Logger } from '../logger.js';
import {
  getUserPrefix,
  parseSessionKey,
  SessionManager,
} from '../session/manager.js';
import { SessionStore } from '../session/store.js';
import type { IncomingMessage } from '../types/channel.js';

export class Controller {
  private eventBus: EventBus;
  private messageBus: MessageBus;
  private dispatcher: MessageDispatcher;
  private feishuChannel?: FeishuChannel;
  private a2aChannel?: A2AServerChannel;
  private injectChannel?: InjectChannel;
  schedulerChannel: SchedulerChannel;
  private sessionManager: SessionManager;
  private store: SessionStore;
  private config: AcpClawConfig;
  private workDir: string;
  /** chatId → sessionKey，用于按聊天 ID 定位会话 */
  private chatSessionMap = new Map<string, string>();
  private stopped = false;
  private saveInterval?: ReturnType<typeof setInterval>;
  private startedAt = Date.now();
  private logger: Logger;

  constructor(config: AcpClawConfig, workDir: string) {
    this.config = config;
    this.workDir = workDir;
    this.logger = createLogger(workDir);

    const sessionsDir = join(workDir, 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    this.store = new SessionStore(sessionsDir);
    this.sessionManager = new SessionManager(config, workDir);
    this.eventBus = new EventBus();
    this.messageBus = new MessageBus();

    this.dispatcher = new MessageDispatcher({
      eventBus: this.eventBus,
      sessionManager: this.sessionManager,
      messageBus: this.messageBus,
      config,
      workDir,
      logger: this.logger,
    });

    // 恢复 chatId → sessionKey 映射，重启后注入仍然可用
    const savedState = this.store.loadControllerState();
    if (savedState?.chatSessionMap) {
      for (const [chatId, sessionKey] of Object.entries(
        savedState.chatSessionMap,
      )) {
        this.chatSessionMap.set(chatId, sessionKey);
      }
    }

    this.schedulerChannel = new SchedulerChannel(workDir, {
      info: (msg) => this.logger.info('scheduler', msg),
      error: (msg, err) =>
        this.logger.error('scheduler', String(msg) + (err ? ` ${err}` : '')),
    });
  }

  async start(): Promise<void> {
    console.log('🚀 Starting ACP Claw');
    this.logger.cleanOldLogs(30);
    console.log(`   Work directory: ${this.workDir}`);
    console.log(`   Default agent: ${this.config.defaultAgent}`);

    await this.sessionManager.restore();

    // Start Feishu channel if configured
    if (this.config.feishu) {
      this.feishuChannel = new FeishuChannel(this.config.feishu);

      this.feishuChannel.onMessage((msg: IncomingMessage) => {
        // sessionMode='chat' 时按聊天隔离会话：同一用户在私聊/不同群里各自独立上下文
        const sessionUserId =
          this.config.sessionMode === 'chat' && msg.chatId
            ? `${msg.chatId}_${msg.sender.id}`
            : msg.sender.id;
        const userPrefix = getUserPrefix('feishu', sessionUserId);
        const sessionKey = this.sessionManager.getActiveSessionKey(userPrefix);
        if (msg.chatId) {
          this.chatSessionMap.set(msg.chatId, sessionKey);
        }
        this.eventBus.emit('message-arrived', {
          message: {
            id: msg.id,
            content: msg.content,
            senderId: msg.sender.id,
            chatId: msg.chatId,
            chatType: msg.chatType,
          },
          channel: 'feishu',
          sessionKey,
          userPrefix,
        });
      });

      await this.feishuChannel.start(this.messageBus);
      console.log('✅ Feishu Channel started');
    } else {
      console.log('⚠️  Feishu Channel not configured');
    }

    // Start A2A channel if configured
    if (this.config.a2a) {
      this.a2aChannel = new A2AServerChannel(this.config.a2a);

      this.a2aChannel.onMessage((msg: IncomingMessage) => {
        const userPrefix = getUserPrefix('a2a', msg.sender.id);
        const sessionKey = this.sessionManager.getActiveSessionKey(userPrefix);
        this.eventBus.emit('message-arrived', {
          message: {
            id: msg.id,
            content: msg.content,
            senderId: msg.sender.id,
            chatId: msg.chatId,
          },
          channel: 'a2a',
          sessionKey,
          userPrefix,
        });
      });

      await this.a2aChannel.start(this.messageBus);
      console.log(`✅ A2A Channel started on port ${this.config.a2a.port}`);
    }

    // Start Inject channel if configured
    if (this.config.inject) {
      this.injectChannel = new InjectChannel(this.config.inject, {
        resolveSessionKey: (chatId) => this.chatSessionMap.get(chatId),
        resolveChatId: (sessionKey) => {
          for (const [chatId, key] of this.chatSessionMap) {
            if (key === sessionKey) return chatId;
          }
          return undefined;
        },
        listSessions: () =>
          this.sessionManager.listActive().map((session) => {
            const info: {
              sessionKey: string;
              chatId?: string;
              busy: boolean;
              isNew: boolean;
            } = {
              sessionKey: session.sessionKey,
              busy: session.busy,
              isNew: session.isNew,
            };
            for (const [chatId, key] of this.chatSessionMap) {
              if (key === session.sessionKey) {
                info.chatId = chatId;
                break;
              }
            }
            return info;
          }),
      });

      this.injectChannel.onMessage(async (msg) => {
        const raw = msg.raw as
          | { sessionKey?: string; sourceChannel?: string }
          | undefined;
        const sessionKey = raw?.sessionKey;
        if (!sessionKey) {
          return { success: false, error: 'sessionKey not resolved' };
        }

        const parsed = parseSessionKey(sessionKey);
        const userPrefix = parsed
          ? `${parsed.channel}_${parsed.userId}_`
          : 'inject_';
        const channel = raw?.sourceChannel ?? 'feishu';

        this.eventBus.emit('message-arrived', {
          message: {
            id: '',
            content: msg.content,
            senderId: msg.sender.id,
            chatId: msg.chatId,
            chatType: 'p2p',
            raw: {
              sourceChannel: channel,
              isInjected: true,
            },
          },
          channel,
          sessionKey,
          userPrefix,
        });

        return { success: true, sessionKey };
      });

      await this.injectChannel.start(this.messageBus);
      console.log(
        `✅ Inject Channel started on port ${this.config.inject.port}`,
      );
    }

    // Start Scheduler channel
    this.schedulerChannel.onMessage((msg: IncomingMessage) => {
      const raw = msg.raw as
        | { sessionKey?: string; sourceChannel?: string }
        | undefined;

      let sessionKey: string;
      let userPrefix: string;
      if (raw?.sessionKey) {
        sessionKey = raw.sessionKey;
        const parsed = parseSessionKey(sessionKey);
        userPrefix = parsed
          ? `${parsed.channel}_${parsed.userId}_`
          : getUserPrefix('scheduler', msg.sender.id);
      } else {
        userPrefix = getUserPrefix('scheduler', msg.sender.id);
        sessionKey = this.sessionManager.getActiveSessionKey(userPrefix);
      }

      this.eventBus.emit('message-arrived', {
        message: {
          id: msg.id,
          content: msg.content,
          senderId: msg.sender.id,
          chatId: msg.chatId,
          raw: msg.raw,
        },
        channel: raw?.sourceChannel ?? 'scheduler',
        sessionKey,
        userPrefix,
      });
    });

    await this.schedulerChannel.start(this.messageBus);
    console.log('✅ Scheduler Channel started');

    this.saveInterval = setInterval(
      () => this.saveState(),
      this.config.stateSaveIntervalMs ?? 30_000,
    );
    this.registerSignalHandlers();
    console.log('✅ ACP Claw is running');
    await this.keepAlive();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    console.log('🛑 Stopping ACP Claw');
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.saveState();
    this.dispatcher.destroy();
    await this.schedulerChannel.stop();
    await this.feishuChannel?.stop();
    await this.a2aChannel?.stop();
    await this.injectChannel?.stop();
    await this.sessionManager.shutdownAll();
    this.messageBus.destroy();
    this.eventBus.removeAll();
  }

  private saveState(): void {
    this.sessionManager.saveAll();
    this.store.saveControllerState({
      startedAt: this.startedAt,
      lastActivityAt: Date.now(),
      activeSessions: this.sessionManager.listActive().map((s) => s.sessionKey),
      chatSessionMap: Object.fromEntries(this.chatSessionMap),
    });
  }

  private registerSignalHandlers(): void {
    const gracefulShutdown = async () => {
      await this.stop();
      process.exit(0);
    };
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('beforeExit', () => this.saveState());
  }

  private keepAlive(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.stopped) {
          resolve();
          return;
        }
        setTimeout(check, 5000);
      };
      check();
    });
  }
}
