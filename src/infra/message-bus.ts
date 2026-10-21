import type {
  MessageHandler,
  OutgoingMessage,
  OutgoingMessageResult,
} from '../types/messages.js';

export class MessageBus {
  private handlers = new Map<string, MessageHandler>();

  async publish(message: OutgoingMessage): Promise<OutgoingMessageResult> {
    const handler = this.handlers.get(message.channelName);
    if (!handler) {
      return {
        success: false,
        error: `No channel subscribed for "${message.channelName}"`,
      };
    }
    try {
      return await handler(message);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  subscribe(channelName: string, handler: MessageHandler): void {
    this.handlers.set(channelName, handler);
  }

  unsubscribe(channelName: string): void {
    this.handlers.delete(channelName);
  }

  hasSubscriber(channelName: string): boolean {
    return this.handlers.has(channelName);
  }

  destroy(): void {
    this.handlers.clear();
  }
}
