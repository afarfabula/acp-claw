import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';

import { InjectChannel, type InjectChannelDeps } from '../src/channel/inject';
import { MessageBus } from '../src/infra/message-bus';
import type { IncomingMessage } from '../src/types/channel';

describe('InjectChannel', () => {
  let channel: InjectChannel;
  let messageBus: MessageBus;
  let received: IncomingMessage[];
  let deps: InjectChannelDeps;

  beforeEach(async () => {
    received = [];
    deps = {
      resolveSessionKey: (chatId) =>
        chatId === 'oc_known' ? 'feishu_ou_user_1' : undefined,
      resolveChatId: (sessionKey) =>
        sessionKey === 'feishu_ou_user_1' ? 'oc_known' : undefined,
      listSessions: () => [
        {
          sessionKey: 'feishu_ou_user_1',
          chatId: 'oc_known',
          busy: false,
          isNew: false,
        },
      ],
    };

    messageBus = new MessageBus();
    channel = new InjectChannel({ port: 0 }, deps);
    channel.onMessage(async (msg) => {
      received.push(msg);
      return { success: true, sessionKey: 'feishu_ou_user_1' };
    });
    await channel.start(messageBus);
  });

  afterEach(async () => {
    await channel.stop();
  });

  const request = (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    fetch(`http://127.0.0.1:${channel.listeningPort}${path}`, init).then(
      async (res) => ({
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      }),
    );

  it('should answer health check', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should list sessions', async () => {
    const res = await request('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      {
        sessionKey: 'feishu_ou_user_1',
        chatId: 'oc_known',
        busy: false,
        isNew: false,
      },
    ]);
  });

  it('should inject by chatId into the mapped session', async () => {
    const res = await request('/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'oc_known',
        text: 'hello from trigger',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('hello from trigger');
    expect(received[0].chatId).toBe('oc_known');
    expect(received[0].raw).toMatchObject({ sessionKey: 'feishu_ou_user_1' });
  });

  it('should reject unknown chatId with 404', async () => {
    const res = await request('/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_unknown', text: 'hi' }),
    });

    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it('should require text', async () => {
    const res = await request('/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'oc_known', text: '' }),
    });

    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe('InjectChannel auth', () => {
  it('should reject requests without token when configured', async () => {
    const messageBus = new MessageBus();
    const channel = new InjectChannel(
      { port: 0, token: 'secret' },
      {
        resolveSessionKey: () => undefined,
        resolveChatId: () => undefined,
        listSessions: () => [],
      },
    );
    channel.onMessage(async () => ({ success: true }));
    await channel.start(messageBus);

    try {
      const noToken = await fetch(
        `http://127.0.0.1:${channel.listeningPort}/sessions`,
      );
      expect(noToken.status).toBe(401);

      const withToken = await fetch(
        `http://127.0.0.1:${channel.listeningPort}/sessions`,
        { headers: { Authorization: 'Bearer secret' } },
      );
      expect(withToken.status).toBe(200);
    } finally {
      await channel.stop();
    }
  });
});
