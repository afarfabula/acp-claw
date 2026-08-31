import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage as HttpIncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { InjectChannelConfig } from '../config.js';
import type { IncomingMessage } from '../types/channel.js';
import type { MessageBus } from '../types/messages.js';

export interface InjectDispatchResult {
  success: boolean;
  sessionKey?: string;
  error?: string;
}

export interface InjectSessionInfo {
  sessionKey: string;
  chatId?: string;
  busy?: boolean;
  isNew?: boolean;
}

export interface InjectChannelDeps {
  /** 按 chatId 解析当前活动的会话 key */
  resolveSessionKey(chatId: string): string | undefined;
  /** 按 session key 反查 chatId（用于只传 sessionKey 时回发消息） */
  resolveChatId(sessionKey: string): string | undefined;
  /** 列出可注入的会话信息 */
  listSessions(): InjectSessionInfo[];
}

export type InjectMessageHandler = (
  message: IncomingMessage,
) => InjectDispatchResult | Promise<InjectDispatchResult>;

interface InjectRequestBody {
  text?: unknown;
  sessionKey?: unknown;
  chatId?: unknown;
  senderId?: unknown;
  senderName?: unknown;
  sourceChannel?: unknown;
}

const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Inject Channel
 *
 * 本地 HTTP 通道，允许外部进程（监控脚本、定时器、webhook 等）把一条消息
 * 注入到 acp-claw 的指定会话中。与普通消息一样走完整的 AI 推理管线，
 * 因此注入后 LLM 带着该会话的完整上下文推理，并把回复发回对应聊天。
 */
export class InjectChannel {
  readonly name = 'inject';

  private config: InjectChannelConfig;
  private deps: InjectChannelDeps;
  private server: Server | null = null;
  private messageBus?: MessageBus;
  private messageHandler?: InjectMessageHandler;

  constructor(config: InjectChannelConfig, deps: InjectChannelDeps) {
    this.config = config;
    this.deps = deps;
  }

  async start(messageBus: MessageBus): Promise<void> {
    this.messageBus = messageBus;
    this.server = createServer((req, res) => void this.handleRequest(req, res));

    return new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(
        this.config.port,
        this.config.host ?? '127.0.0.1',
        () => {
          this.server!.removeListener('error', reject);
          resolve();
        },
      );
    });
  }

  async stop(): Promise<void> {
    this.messageHandler = undefined;
    this.messageBus?.unsubscribe(this.name);

    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  onMessage(handler: InjectMessageHandler): void {
    this.messageHandler = handler;
  }

  /** 实际监听的端口（测试/调试用） */
  get listeningPort(): number | undefined {
    const address = this.server?.address();
    if (address && typeof address === 'object') {
      return address.port;
    }
    return undefined;
  }

  private async handleRequest(
    req: HttpIncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '';

    if (req.method === 'GET' && url === '/health') {
      this.writeJson(res, 200, { ok: true, name: this.name });
      return;
    }

    if (req.method === 'GET' && url === '/sessions') {
      if (!this.isAuthorized(req)) {
        this.writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      this.writeJson(res, 200, { sessions: this.deps.listSessions() });
      return;
    }

    if (req.method === 'POST' && url === '/inject') {
      await this.handleInject(req, res);
      return;
    }

    this.writeJson(res, 404, { error: 'Not found' });
  }

  private isAuthorized(req: HttpIncomingMessage): boolean {
    if (!this.config.token) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${this.config.token}`;
  }

  private async handleInject(
    req: HttpIncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    let body: InjectRequestBody;
    try {
      body = await this.readBody(req);
    } catch {
      this.writeJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      this.writeJson(res, 400, { error: 'text is required' });
      return;
    }

    const requestedSessionKey =
      typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
    const requestedChatId =
      typeof body.chatId === 'string' ? body.chatId.trim() : '';

    let sessionKey = requestedSessionKey;
    if (!sessionKey) {
      if (!requestedChatId) {
        this.writeJson(res, 400, {
          error: 'sessionKey or chatId is required',
        });
        return;
      }
      const resolved = this.deps.resolveSessionKey(requestedChatId);
      if (!resolved) {
        this.writeJson(res, 404, {
          error: `No session found for chatId: ${requestedChatId}`,
        });
        return;
      }
      sessionKey = resolved;
    }

    let chatId = requestedChatId;
    if (!chatId) {
      chatId = this.deps.resolveChatId(sessionKey) ?? '';
      if (!chatId) {
        this.writeJson(res, 400, {
          error: `chatId is required (no chat mapping found for session: ${sessionKey})`,
        });
        return;
      }
    }

    if (!this.messageHandler) {
      this.writeJson(res, 503, { error: 'Inject channel handler not ready' });
      return;
    }

    const senderId =
      typeof body.senderId === 'string' && body.senderId.trim()
        ? body.senderId.trim()
        : 'trigger';
    const senderName =
      typeof body.senderName === 'string' && body.senderName.trim()
        ? body.senderName.trim()
        : 'trigger';
    const sourceChannel =
      typeof body.sourceChannel === 'string' && body.sourceChannel.trim()
        ? body.sourceChannel.trim()
        : 'feishu';

    const message: IncomingMessage = {
      id: `inject_${Date.now()}_${randomUUID()}`,
      channelName: this.name,
      type: 'text',
      content: text,
      sender: { id: senderId, name: senderName },
      chatId,
      chatType: 'p2p',
      timestamp: Date.now(),
      raw: {
        isInjected: true,
        sessionKey,
        sourceChannel,
      },
    };

    try {
      const result = await this.messageHandler(message);
      if (result.success) {
        this.writeJson(res, 200, {
          success: true,
          sessionKey: result.sessionKey ?? sessionKey,
          chatId,
        });
      } else {
        this.writeJson(res, 500, {
          success: false,
          error: result.error ?? 'Inject failed',
        });
      }
    } catch (error) {
      this.writeJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readBody(req: HttpIncomingMessage): Promise<InjectRequestBody> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(
            Buffer.concat(chunks).toString('utf-8'),
          ) as InjectRequestBody;
          resolve(parsed);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private writeJson(res: ServerResponse, status: number, data: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
