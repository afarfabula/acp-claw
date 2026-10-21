export interface OutgoingMessage {
  channelName: string;
  messageId?: string;
  chatId?: string;
  type: 'text' | 'clear-reaction' | 'status-update';
  content: string;
}

export interface OutgoingMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface MessageBus {
  publish(message: OutgoingMessage): Promise<OutgoingMessageResult>;
  subscribe(channelName: string, handler: MessageHandler): void;
  unsubscribe(channelName: string): void;
  hasSubscriber(channelName: string): boolean;
  destroy(): void;
}

export type MessageHandler = (
  message: OutgoingMessage,
) => Promise<OutgoingMessageResult>;
