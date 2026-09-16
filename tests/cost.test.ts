import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';

import {
  costOfTurn,
  formatCny,
  isPeak,
  resolveModel,
} from '../src/cost/pricing';
import {
  codexHomeDir,
  computeRoundCost,
  findRolloutFile,
  formatCostLine,
} from '../src/cost/session-cost';
// 参考实现：工作区工具 tools/codex-cost（状态栏用的同一套算法）
import {
  lastRound as refLastRound,
  parseRollout as refParseRollout,
} from '../tools/codex-cost/usage.mjs';

/** 造一条 Codex 会话记录行 */
function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

function taskStarted(ts: string): string {
  return line({
    type: 'event_msg',
    timestamp: ts,
    payload: { type: 'task_started' },
  });
}

function turnContext(ts: string, model: string): string {
  return line({ type: 'turn_context', timestamp: ts, payload: { model } });
}

function tokenCount(
  ts: string,
  usage: { input: number; cached: number; output: number },
): string {
  return line({
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached,
          output_tokens: usage.output,
        },
      },
    },
  });
}

describe('pricing', () => {
  it('高峰/空闲时段按北京时间判定', () => {
    // 2026-09-16 是周三：北京 10:00 高峰，13:00 空闲，19:00 空闲
    expect(isPeak(new Date('2026-09-16T02:00:00Z'))).toBe(true);
    expect(isPeak(new Date('2026-09-16T05:00:00Z'))).toBe(false);
    expect(isPeak(new Date('2026-09-16T11:00:00Z'))).toBe(false);
    // 周日全天空闲
    expect(isPeak(new Date('2026-09-20T02:00:00Z'))).toBe(false);
  });

  it('缓存命中按 1/50 计价，未命中按全价', () => {
    const peak = new Date('2026-09-16T02:00:00Z');
    // 1M 输入全部未命中 + 0 输出 = ¥2
    expect(
      costOfTurn({ input: 1_000_000, cached: 0, output: 0 }, null, peak).cost,
    ).toBeCloseTo(2, 6);
    // 1M 输入全部命中 = 1M × ¥0.04 = ¥0.04
    expect(
      costOfTurn({ input: 1_000_000, cached: 1_000_000, output: 0 }, null, peak)
        .cost,
    ).toBeCloseTo(0.04, 6);
    // 空闲时段半价
    const offPeak = new Date('2026-09-16T05:00:00Z');
    expect(
      costOfTurn({ input: 1_000_000, cached: 0, output: 0 }, null, offPeak)
        .cost,
    ).toBeCloseTo(1, 6);
  });

  it('别名与未知模型都能落到计价表', () => {
    expect(resolveModel('deepseek-v4-flash')).toBe('deepseek-flash');
    expect(resolveModel('deepseek-flash')).toBe('deepseek-flash');
    expect(resolveModel('')).toBe('deepseek-flash');
    expect(resolveModel('whatever')).toBe('deepseek-flash');
  });

  it('金额按大小自适应小数位', () => {
    expect(formatCny(0.0781)).toBe('¥0.078');
    expect(formatCny(1.234)).toBe('¥1.23');
    expect(formatCny(12.34)).toBe('¥12.34');
    expect(formatCny(123.4)).toBe('¥123.4');
    expect(formatCny(0.0042)).toBe('¥0.0042');
  });
});

describe('session-cost', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-cost-'));
    mkdirSync(join(dir, 'sessions', '2026', '09', '16'), { recursive: true });
    file = join(
      dir,
      'sessions/2026/09/16/rollout-2026-09-16T10-00-00-abc123.jsonl',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('按 thread id 能找到会话记录文件', () => {
    writeFileSync(file, '');
    expect(findRolloutFile('abc123', dir)).toBe(file);
    expect(findRolloutFile('nope', dir)).toBeNull();
  });

  it('只统计最后一个回合的请求（task_started 之后的）', () => {
    // 2026-09-16 是周三：北京 09:00-12:00 为高峰 = UTC 01:00-04:00
    const t = (h: number, m: number) =>
      `2026-09-16T0${h}:${String(m).padStart(2, '0')}:00.000Z`;
    writeFileSync(
      file,
      turnContext(t(1, 0), 'deepseek-flash') +
        // 上一个回合：1 次请求，1M 未命中输入 = ¥2
        taskStarted(t(1, 1)) +
        tokenCount(t(1, 2), { input: 1_000_000, cached: 0, output: 0 }) +
        // 本回合：2 次请求
        taskStarted(t(2, 30)) +
        tokenCount(t(2, 31), {
          input: 200_000,
          cached: 198_000,
          output: 1_000,
        }) +
        tokenCount(t(2, 32), {
          input: 210_000,
          cached: 209_000,
          output: 2_000,
        }),
    );

    const cost = computeRoundCost(file);
    expect(cost).not.toBeNull();
    expect(cost?.requests).toBe(2);
    expect(cost?.input).toBe(410_000);
    expect(cost?.cached).toBe(407_000);
    expect(cost?.peakRequests).toBe(2);
    // 未命中 2000+1000 = 3000 × ¥2/M；命中 407k × ¥0.04/M；输出 3000 × ¥8/M
    const expected =
      (3_000 / 1_000_000) * 2 +
      (407_000 / 1_000_000) * 0.04 +
      (3_000 / 1_000_000) * 8;
    expect(cost?.amount).toBeCloseTo(expected, 6);
    const text = formatCostLine(cost as NonNullable<typeof cost>);
    expect(text).toContain('本回合');
    expect(text).toContain('2 次请求');
    expect(text).toContain('高峰');
  });

  it('没有 task_started 的老会话退回最后一次请求', () => {
    const peak = '2026-09-16T02:00:00.000Z';
    const later = '2026-09-16T02:01:00.000Z';
    writeFileSync(
      file,
      turnContext(peak, 'deepseek-flash') +
        tokenCount(peak, { input: 1_000_000, cached: 0, output: 0 }) +
        tokenCount(later, { input: 100_000, cached: 100_000, output: 0 }),
    );
    const cost = computeRoundCost(file);
    expect(cost?.requests).toBe(1);
    expect(cost?.amount).toBeCloseTo(0.004, 6);
  });

  it('空文件 / 无请求时返回 null', () => {
    writeFileSync(
      file,
      turnContext('2026-09-16T02:00:00.000Z', 'deepseek-flash'),
    );
    expect(computeRoundCost(file)).toBeNull();
  });

  it('与 tools/codex-cost（状态栏口径）算出同样的回合花费', () => {
    const t = (h: number, m: number) =>
      `2026-09-16T0${h}:${String(m).padStart(2, '0')}:00.000Z`;
    writeFileSync(
      file,
      turnContext(t(1, 0), 'deepseek-flash') +
        taskStarted(t(1, 1)) +
        tokenCount(t(1, 2), { input: 500_000, cached: 499_000, output: 500 }) +
        taskStarted(t(2, 40)) +
        tokenCount(t(2, 41), {
          input: 300_000,
          cached: 297_000,
          output: 1_500,
        }) +
        tokenCount(t(2, 42), { input: 310_000, cached: 309_500, output: 900 }),
    );

    const mine = computeRoundCost(file);
    const parsed = refParseRollout(file);
    const refRound = refLastRound(parsed);
    // parseRollout 已经按同一价目表算好每一轮 cost
    const refAmount = refRound.turns.reduce((sum, turn) => sum + turn.cost, 0);

    expect(mine?.requests).toBe(refRound.turns.length);
    expect(mine?.amount).toBeCloseTo(refAmount, 9);
  });

  it('真实会话记录也能算出来（没有则跳过）', () => {
    const home = codexHomeDir();
    const real = findRolloutFile(
      process.env.ACP_CLAW_TEST_SESSION_ID ??
        '01a05307-2bdf-7f21-a10d-7e857c4e735d',
      home,
    );
    if (!real) return; // 本机没有这份记录时不计失败
    const cost = computeRoundCost(real);
    expect(cost).not.toBeNull();
    expect(cost?.requests).toBeGreaterThan(0);
    expect(cost?.amount).toBeGreaterThan(0);
    expect(cost?.cachedRatio).toBeGreaterThan(0.5);
    // 与状态栏口径逐位对齐（真实会话数据上的等价性检查）
    const refRound = refLastRound(refParseRollout(real));
    expect(cost?.requests).toBe(refRound.turns.length);
    expect(cost?.amount).toBeCloseTo(
      refRound.turns.reduce((sum, turn) => sum + turn.cost, 0),
      9,
    );
    if (process.env.ACP_CLAW_COST_DEBUG) {
      console.log(
        `[cost] ${real}\n[cost] ${formatCostLine(cost as NonNullable<typeof cost>)}`,
      );
    }
  });
});
