import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage as HttpIncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { A2AChannelConfig } from '../config.js';
import type { Channel, IncomingMessage } from '../types/channel.js';
import type {
  MessageBus,
  OutgoingMessage,
  OutgoingMessageResult,
} from '../types/messages.js';

interface A2AMessagePart {
  kind: 'text' | 'data' | 'file';
  text?: string;
  data?: unknown;
  mimeType?: string;
  uri?: string;
  bytes?: string;
}

interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: A2AMessagePart[];
  contextId?: string;
}

interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  protocolVersion: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

type ResponseResolver = {
  writeArtifact: (content: string) => void;
  writeEvent: (data: unknown) => void;
  complete: () => void;
  messageId: string;
  contextId: string;
  timeout?: ReturnType<typeof setTimeout>;
};

export class A2AServerChannel implements Channel {
  readonly name = 'a2a';
  private config: A2AChannelConfig;
  private server: Server | null = null;
  private messageBus?: MessageBus;
  private messageHandler?: (message: IncomingMessage) => void;
  private pendingResponses = new Map<string, ResponseResolver>();
  private taskToMessage = new Map<string, string>();

  constructor(config: A2AChannelConfig) {
    this.config = config;
  }

  async start(messageBus: MessageBus): Promise<void> {
    this.messageBus = messageBus;
    this.messageBus.subscribe(this.name, (msg) => this.handleOutgoing(msg));
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.config.port, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.messageHandler = undefined;
    this.messageBus?.unsubscribe(this.name);

    for (const [messageId, pending] of Array.from(
      this.pendingResponses.entries(),
    )) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pendingResponses.delete(messageId);
      try {
        pending.complete();
      } catch {
        /* response may already be closed */
      }
    }
    this.taskToMessage.clear();

    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  reply(messageId: string, text: string): void {
    const pending = this.pendingResponses.get(messageId);
    if (pending) {
      pending.writeArtifact(text);
    }
  }

  completeResponse(messageId: string): void {
    const pending = this.pendingResponses.get(messageId);
    if (pending) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pendingResponses.delete(messageId);
      for (const [taskId, msgId] of Array.from(this.taskToMessage.entries())) {
        if (msgId === messageId) {
          this.taskToMessage.delete(taskId);
          break;
        }
      }
      pending.complete();
    }
  }

  completeResponseByContext(contextId: string): void {
    for (const [messageId, pending] of Array.from(
      this.pendingResponses.entries(),
    )) {
      if (pending.contextId === contextId) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        this.pendingResponses.delete(messageId);
        for (const [taskId, msgId] of Array.from(
          this.taskToMessage.entries(),
        )) {
          if (msgId === messageId) {
            this.taskToMessage.delete(taskId);
            break;
          }
        }
        pending.complete();
        return;
      }
    }
  }

  private getAgentCard(): A2AAgentCard {
    return {
      name: this.config.name,
      description: this.config.description,
      url: `http://localhost:${this.config.port}/a2a/jsonrpc`,
      protocolVersion: '0.3.0',
      version: '1.0.0',
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: [
        {
          id: 'chat',
          name: 'Chat',
          description: 'Interact with the agent',
          tags: ['chat'],
        },
      ],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    };
  }

  private handleRequest(req: HttpIncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '';

    if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getAgentCard()));
      return;
    }

    if (req.method === 'POST' && url === '/a2a/jsonrpc') {
      this.readBody(req).then(
        (body) => this.handleJsonRpc(body, res),
        () => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        },
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private readBody(req: HttpIncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf-8'),
          ) as Record<string, unknown>;
          resolve(body);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private handleJsonRpc(
    body: Record<string, unknown>,
    res: ServerResponse,
  ): void {
    const method = body.method as string | undefined;
    const params = body.params as Record<string, unknown> | undefined;
    const id = body.id as string | undefined;

    if (method === 'message/send') {
      this.handleMessageSend(params, res);
      return;
    }

    if (method === 'task/cancel') {
      const taskId = (params?.taskId as string) || '';
      this.handleTaskCancel(taskId, res);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not found' },
        id,
      }),
    );
  }

  private handleMessageSend(
    params: Record<string, unknown> | undefined,
    res: ServerResponse,
  ): void {
    const message = params?.message as A2AMessage | undefined;
    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message in params' }));
      return;
    }

    const textPart = message.parts?.find((p) => p.kind === 'text');
    const fileParts = message.parts?.filter((p) => p.kind === 'file') || [];
    let content = textPart?.text || '';

    if (fileParts.length > 0) {
      const fileInfo = fileParts
        .map(
          (f) =>
            `[文件: ${f.uri || '(inline)'}${f.mimeType ? ` (${f.mimeType})` : ''}]`,
        )
        .join('\n');
      content = content ? `${content}\n${fileInfo}` : fileInfo;
    }

    const taskId = randomUUID();
    const contextId =
      (params?.contextId as string) || message.contextId || randomUUID();
    const messageId = message.messageId || randomUUID();

    const metadata = params?.metadata as Record<string, unknown> | undefined;
    const callerAgent = metadata?.agent as Record<string, unknown> | undefined;
    const callerName =
      (callerAgent?.name as string) ||
      (metadata?.agentName as string) ||
      (metadata?.name as string) ||
      '';
    const senderName = callerName || 'A2A Client';
    const senderId = (metadata?.senderAgentId as string) || `a2a_${contextId}`;

    // Start SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const writeSSE = (data: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeSSE({
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [message],
    });

    writeSSE({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    });

    // Register pending response
    const artifactId = randomUUID();
    let artifactIndex = 0;
    let hasArtifact = false;
    this.taskToMessage.set(taskId, messageId);
    this.pendingResponses.set(messageId, {
      writeArtifact: (text: string) => {
        hasArtifact = true;
        writeSSE({
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: {
            artifactId,
            name: 'response',
            parts: [{ kind: 'text', text }],
            index: artifactIndex++,
          },
          append: artifactIndex > 1,
          lastChunk: false,
        });
      },
      complete: () => {
        if (hasArtifact) {
          writeSSE({
            kind: 'artifact-update',
            taskId,
            contextId,
            artifact: {
              artifactId,
              name: 'response',
              parts: [],
              index: artifactIndex,
            },
            lastChunk: true,
          });
        }
        writeSSE({
          kind: 'status-update',
          taskId,
          contextId,
          status: { state: 'completed', timestamp: new Date().toISOString() },
          final: true,
        });
        if (!res.writableEnded) {
          res.end();
        }
      },
      writeEvent: writeSSE,
      messageId,
      contextId,
    });

    // Dispatch to handler
    const incoming: IncomingMessage = {
      id: messageId,
      channelName: this.name,
      type: 'text',
      content,
      sender: { id: senderId, name: senderName },
      chatId: contextId,
      chatType: 'p2p',
      timestamp: Date.now(),
      raw: params,
    };

    this.messageHandler?.(incoming);

    // Timeout
    const timeout = setTimeout(() => {
      this.pendingResponses.delete(messageId);
      this.taskToMessage.delete(taskId);
      writeSSE({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'agent',
            parts: [{ kind: 'text', text: 'Request timed out' }],
          },
        },
        final: true,
      });
      if (!res.writableEnded) {
        res.end();
      }
    }, 10 * 60_000);

    const resolver = this.pendingResponses.get(messageId);
    if (resolver) {
      resolver.timeout = timeout;
    }

    res.on('close', () => {
      clearTimeout(timeout);
      this.pendingResponses.delete(messageId);
      this.taskToMessage.delete(taskId);
    });
  }

  private handleTaskCancel(taskId: string, res: ServerResponse): void {
    const messageId = this.taskToMessage.get(taskId);
    if (messageId) {
      const pending = this.pendingResponses.get(messageId);
      if (pending) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        this.pendingResponses.delete(messageId);
        this.taskToMessage.delete(taskId);
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(
      `data: ${JSON.stringify({
        kind: 'status-update',
        taskId,
        contextId: '',
        status: { state: 'canceled', timestamp: new Date().toISOString() },
        final: true,
      })}\n\n`,
    );

    res.end();
  }

  private async handleOutgoing(
    msg: OutgoingMessage,
  ): Promise<OutgoingMessageResult> {
    // Status-update forwarding (intermediate events or completion signal)
    if (msg.type === 'status-update') {
      // Completion signal → close SSE stream
      if (msg.content === 'completed') {
        if (msg.messageId && this.pendingResponses.has(msg.messageId)) {
          this.completeResponse(msg.messageId);
          return { success: true, messageId: msg.messageId };
        }
        if (msg.chatId) {
          this.completeResponseByContext(msg.chatId);
          return { success: true };
        }
        return { success: true };
      }

      // Intermediate status-update: parse content as JSON parts and forward
      let parts: unknown[];
      try {
        parts = JSON.parse(msg.content);
      } catch {
        return { success: false, error: 'Invalid status-update content' };
      }

      let pending: ResponseResolver | undefined;
      let taskId = '';

      if (msg.messageId && this.pendingResponses.has(msg.messageId)) {
        pending = this.pendingResponses.get(msg.messageId);
        for (const [tid, mid] of Array.from(this.taskToMessage.entries())) {
          if (mid === msg.messageId) {
            taskId = tid;
            break;
          }
        }
      } else if (msg.chatId) {
        for (const [mid, p] of Array.from(this.pendingResponses.entries())) {
          if (p.contextId === msg.chatId) {
            pending = p;
            for (const [tid, mmid] of Array.from(
              this.taskToMessage.entries(),
            )) {
              if (mmid === mid) {
                taskId = tid;
                break;
              }
            }
            break;
          }
        }
      }

      if (!pending) {
        return {
          success: false,
          error: 'No matching pending A2A request for status-update',
        };
      }

      pending.writeEvent({
        kind: 'status-update',
        taskId,
        contextId: pending.contextId,
        status: {
          state: 'working',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'agent',
            parts,
          },
        },
        final: false,
      });

      return { success: true, messageId: pending.messageId };
    }

    // Text artifact: find pending by messageId or fallback to chatId/contextId
    if (msg.messageId && this.pendingResponses.has(msg.messageId)) {
      const pending = this.pendingResponses.get(msg.messageId)!;
      pending.writeArtifact(msg.content);
      return { success: true, messageId: msg.messageId };
    }

    if (msg.chatId) {
      for (const [messageId, pending] of Array.from(
        this.pendingResponses.entries(),
      )) {
        if (pending.contextId === msg.chatId) {
          pending.writeArtifact(msg.content);
          return { success: true, messageId };
        }
      }
    }

    return { success: false, error: 'No matching pending A2A request' };
  }
}
