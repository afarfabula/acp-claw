import { expect, test } from '@rstest/core';
import type { SessionUpdate } from '../src/acp/client';
import type { AcpClawConfig } from '../src/config';
import type { Logger } from '../src/logger';
import { PromptPipeline } from '../src/pipeline/pipeline';
import type { SessionManager } from '../src/session/manager';

test('flushes final text when Codex reports idle', async () => {
  const received: string[] = [];
  const sessionManager = {
    prompt: async (
      _sessionKey: string,
      _parts: unknown,
      onUpdate: (update: SessionUpdate) => void,
    ) => {
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      });
      onUpdate({
        sessionUpdate: 'session_info_update',
        _meta: { codex: { threadStatus: { type: 'idle' } } },
      });
      // Simulate Codex 0.164 emitting idle without resolving session/prompt.
      await new Promise<void>(() => {});
    },
  } as unknown as SessionManager;
  const logger = {
    info: () => {},
    warn: () => {},
  } as unknown as Logger;
  const pipeline = new PromptPipeline(
    sessionManager,
    {} as AcpClawConfig,
    logger,
  );

  void pipeline.execute(
    'test',
    [],
    {
      onText: (text) => {
        received.push(text);
      },
      onTool: () => {},
    },
    { expectReplay: false },
  );

  await Promise.resolve();
  await Promise.resolve();
  expect(received).toEqual(['hello']);
});

test('accepts live text after resume without a user echo', async () => {
  const received: string[] = [];
  const sessionManager = {
    prompt: async (
      _sessionKey: string,
      _parts: unknown,
      onUpdate: (update: SessionUpdate) => void,
    ) => {
      onUpdate({
        sessionUpdate: 'session_info_update',
        _meta: { codex: { threadStatus: { type: 'active' } } },
      });
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'resumed' },
      });
      onUpdate({
        sessionUpdate: 'session_info_update',
        _meta: { codex: { threadStatus: { type: 'idle' } } },
      });
      await new Promise<void>(() => {});
    },
  } as unknown as SessionManager;
  const logger = {
    info: () => {},
    warn: () => {},
  } as unknown as Logger;
  const pipeline = new PromptPipeline(
    sessionManager,
    {} as AcpClawConfig,
    logger,
  );

  void pipeline.execute(
    'test',
    [],
    {
      onText: (text) => {
        received.push(text);
      },
      onTool: () => {},
    },
    { expectReplay: true },
  );

  await Promise.resolve();
  await Promise.resolve();
  expect(received).toEqual(['resumed']);
});
