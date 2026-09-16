import type { MessageBus } from './messages.js';

export interface IncomingMessage {
  id: string;
  channelName: string;
  type: 'text' | 'card' | 'card_event';
  content: string;
  sender: {
    id: string;
    name?: string;
  };
  chatId?: string;
  chatType?: 'p2p' | 'group';
  timestamp: number;
  raw?: unknown;
  /** 附件（图片等）。bytes 为 base64，由渠道负责下载 */
  files?: Array<{
    uri?: string;
    bytes?: string;
    mimeType?: string;
    name?: string;
  }>;
  replyMeta?: {
    selfId: string;
    replyTo: string;
    endpoint: string;
    project: string;
  };
}

export interface Channel {
  readonly name: string;
  start(messageBus: MessageBus): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: IncomingMessage) => void): void;
}
