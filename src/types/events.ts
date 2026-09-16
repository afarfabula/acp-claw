export interface ControllerEvents {
  'message-arrived': {
    message: {
      id: string;
      content: string;
      senderId: string;
      chatId?: string;
      chatType?: 'p2p' | 'group';
      raw?: unknown;
      files?: Array<{
        uri?: string;
        bytes?: string;
        mimeType?: string;
        name?: string;
      }>;
    };
    channel: string;
    sessionKey: string;
    userPrefix: string;
  };
  'session-started': { sessionKey: string };
  'session-finished': { sessionKey: string; interrupted: boolean };
  'cron-triggered': {
    task: {
      name: string;
      schedule: string;
      prompt: string;
      chatId?: string;
      oneShot?: boolean;
    };
  };
  'controller-stop': {};
}

export type EventName = keyof ControllerEvents;
