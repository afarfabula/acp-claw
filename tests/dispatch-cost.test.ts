import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';

import type { AcpClawConfig } from '../src/config';
import { resetCostCache } from '../src/cost/session-cost';
import { MessageDispatcher } from '../src/dispatch/message-dispatcher';
import { EventBus } from '../src/infra/event-bus';
import { MessageBus } from '../src/infra/message-bus';
import { Logger } from '../src/logger';
import type { OutgoingMessage } from '../src/types/messages';

const SESSION_ID = 'test-thread-0001';
const SESSION_KEY = 'feishu_ou_demo_1';
// 2026-09-16 周三 10:00 北京 = 高峰
const PEAK = '2026-09-16T02:00:00.000Z';

function rolloutLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

describe('MessageDispatcher × replyCost', () => {
  let dir: string;
  let published: OutgoingMessage[];
  let dispatcher: MessageDispatcher;
  let eventBus: EventBus;
  let config: AcpClawConfig;

  const session = {
    sessionKey: SESSION_KEY,
    busy: false,
    isNew: false,
    expectReplay: false,
    client: null,
    promptPromise: null,
    record: {
      sessionKey: SESSION_KEY,
      acpSessionId: SESSION_ID,
      agentName: 'codex',
      cwd: '/tmp',
      createdAt: 0,
      lastActivityAt: 0,
    },
  };

  function writeRollout(model = 'dsapi-deepseek-flash'): void {
    const day = join(dir, 'sessions', '2026', '09', '16');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-09-16T10-00-00-${SESSION_ID}.jsonl`),
      rolloutLine({
        type: 'turn_context',
        payload: { model },
      }) +
        '{"type":"event_msg","timestamp":"2026-09-16T02:00:00.000Z","payload":{"type":"task_started"}}\n' +
        `{"type":"event_msg","timestamp":"${PEAK}","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100000,"cached_input_tokens":99000,"output_tokens":500}}}}\n`,
    );
  }

  function makeDispatcher(cfg: AcpClawConfig): MessageDispatcher {
    const bus = new MessageBus();
    published = [];
    bus.subscribe('feishu', async (message) => {
      published.push(message);
      return { success: true };
    });
    const sessionManager = {
      getSession: () => session,
      getOrCreate: async () => session,
      prompt: async (
        _key: string,
        _parts: unknown,
        onUpdate: (update: Record<string, unknown>) => void,
      ) => {
        onUpdate({ sessionUpdate: 'user_message_chunk' });
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '答案在这里' },
        });
      },
      cancel: async () => {},
      protectSession: () => {},
      close: async () => {},
    };
    return new MessageDispatcher({
      eventBus,
      sessionManager: sessionManager as never,
      messageBus: bus,
      config: cfg,
      workDir: dir,
      logger: new Logger(dir),
    });
  }

  async function waitForCount(expected: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (published.length >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForText(snippet: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (published.some((m) => String(m.content).includes(snippet))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-claw-dispatch-'));
    writeRollout();
    process.env.CODEX_HOME = dir;
    // Coding Plan 额度查询在测试里不联网：arkcli 指向不存在的路径 + 独立缓存目录
    process.env.ARKCLI_BIN = join(dir, 'missing-arkcli');
    process.env.CODEX_COST_CACHE = join(dir, 'cost-cache');
    process.env.CODEX_COST_NO_BALANCE = '1';
    resetCostCache();
    eventBus = new EventBus();
    config = {
      defaultAgent: 'codex',
      agents: {},
      replyCost: { enabled: true },
    };
    dispatcher = makeDispatcher(config);
  });

  afterEach(() => {
    dispatcher.destroy();
    delete process.env.CODEX_HOME;
    delete process.env.ARKCLI_BIN;
    delete process.env.CODEX_COST_CACHE;
    delete process.env.CODEX_COST_NO_BALANCE;
    resetCostCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function emit(): void {
    eventBus.emit('message-arrived', {
      message: { id: 'om_demo', content: '你好', senderId: 'ou_demo' },
      channel: 'feishu',
      sessionKey: SESSION_KEY,
      userPrefix: 'feishu_ou_demo',
    });
  }

  it('开启后：回复末尾追加本回合花费', async () => {
    emit();
    await waitForCount(2);
    const texts = published.map((m) => String(m.content));
    expect(texts.some((t) => t.includes('答案在这里'))).toBe(true);
    const costLine = texts.find((t) => t.startsWith('💸 本回合'));
    expect(costLine).toBeDefined();
    expect(costLine).toContain('1 次请求');
    expect(costLine).toContain('耗时');
    expect(costLine).toContain('高峰');
    expect(costLine).toContain('会话累计');
  });

  it('Coding Plan 车道：改报套餐口径的一行（额度查不到也不报人民币）', async () => {
    dispatcher.destroy();
    writeRollout('doubao-seed-2.1-lite');
    resetCostCache();
    dispatcher = makeDispatcher(config);
    emit();
    await waitForCount(2);
    const texts = published.map((m) => String(m.content));
    const costLine = texts.find((t) => t.startsWith('🎟️'));
    expect(costLine).toBeDefined();
    expect(costLine).toContain('走 Coding Plan');
    expect(costLine).toContain('doubao-seed-2.1-lite');
    expect(costLine).toContain('1 次请求');
    expect(costLine).toContain('会话累计');
    expect(costLine).not.toContain('¥');
    expect(texts.some((t) => t.startsWith('💸'))).toBe(false);
  });

  it('长任务会中途发「⏳ 进行中」进度', async () => {
    dispatcher.destroy();
    const bus = new MessageBus();
    published = [];
    bus.subscribe('feishu', async (message) => {
      published.push(message);
      return { success: true };
    });
    dispatcher = new MessageDispatcher({
      eventBus,
      sessionManager: {
        getSession: () => session,
        getOrCreate: async () => session,
        prompt: async (
          _key: string,
          _parts: unknown,
          onUpdate: (update: Record<string, unknown>) => void,
        ) => {
          onUpdate({
            sessionUpdate: 'tool_call',
            title: 'Running command',
            status: 'in_progress',
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '答案在这里' },
            _meta: { type: 'partial', lastChunk: true },
          });
        },
        cancel: async () => {},
        protectSession: () => {},
        close: async () => {},
      } as never,
      messageBus: bus,
      config: {
        ...config,
        progress: { enabled: true, afterMs: 30, intervalMs: 30 },
      },
      workDir: dir,
      logger: new Logger(dir),
    });
    emit();
    await waitForText('答案在这里');
    const texts = published.map((m) => String(m.content));
    const progressLine = texts.find((t) => t.startsWith('⏳ 进行中'));
    expect(progressLine).toBeDefined();
    expect(progressLine).toContain('Running command');
    expect(texts.some((t) => t.includes('答案在这里'))).toBe(true);
  });

  it('关闭时不追加', async () => {
    dispatcher.destroy();
    dispatcher = makeDispatcher({ ...config, replyCost: { enabled: false } });
    emit();
    await waitForCount(1);
    expect(published.some((m) => String(m.content).startsWith('💸'))).toBe(
      false,
    );
  });

  it('非白名单通道（a2a）不追加', async () => {
    dispatcher.destroy();
    const bus = new MessageBus();
    published = [];
    bus.subscribe('a2a', async (message) => {
      published.push(message);
      return { success: true };
    });
    dispatcher = new MessageDispatcher({
      eventBus,
      sessionManager: {
        getSession: () => session,
        getOrCreate: async () => session,
        prompt: async (
          _key: string,
          _parts: unknown,
          onUpdate: (update: Record<string, unknown>) => void,
        ) => {
          onUpdate({ sessionUpdate: 'user_message_chunk' });
          onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'a2a 回复' },
          });
        },
        cancel: async () => {},
        protectSession: () => {},
        close: async () => {},
      } as never,
      messageBus: bus,
      config,
      workDir: dir,
      logger: new Logger(dir),
    });
    eventBus.emit('message-arrived', {
      message: { id: 'om_demo', content: '你好', senderId: 'ou_demo' },
      channel: 'a2a',
      sessionKey: SESSION_KEY,
      userPrefix: 'feishu_ou_demo',
    });
    await waitForCount(1);
    expect(published.some((m) => String(m.content).startsWith('💸'))).toBe(
      false,
    );
  });
});
