/**
 * 按 Codex 会话记录（codexHome/sessions/年/月/日/rollout-时间-线程id.jsonl）算花费。
 *
 * 一次用户输入（一个回合）会引发多次模型请求：模型 → 工具调用 → 模型 → … → 最终回答，
 * 每次都要重发上下文并单独计费。Codex 在每回合开头写一条 task_started，
 * 因此「本回合花费」= 该时间点之后所有 token_count 事件之和；
 * 「会话累计」= 整个会话文件里所有 token_count 事件之和。
 *
 * 解析是**增量**的：每个文件记住已读到的字节偏移，下次只读新增部分，
 * 所以长会话每回合的开销只与新增行数成正比（口径与 tools/codex-cost 的 lastRound 一致）。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { costOfTurn, formatCny, resolveModel } from './pricing.js';

export interface RoundCost {
  /** 本回合总花费（元） */
  amount: number;
  /** 本回合的模型请求次数 */
  requests: number;
  input: number;
  cached: number;
  output: number;
  /** 本回合缓存命中率（0-1） */
  cachedRatio: number;
  /** 本回合里命中高峰价的请求数 */
  peakRequests: number;
  /** 会话累计花费（元） */
  sessionAmount: number;
  /** 会话累计请求次数 */
  sessionRequests: number;
  model: string;
}

export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** sessionId（= Codex thread id，即 acpSessionId）→ rollout 文件路径 */
const rolloutCache = new Map<string, string>();

/**
 * 按 thread id 找会话记录文件。
 * 文件名形如 rollout-2026-08-30T22-16-14-<threadId>.jsonl，位于 sessions/年/月/日 下。
 */
export function findRolloutFile(
  sessionId: string,
  codexHome: string = codexHomeDir(),
): string | null {
  const cached = rolloutCache.get(sessionId);
  if (cached) return cached;

  const suffix = `-${sessionId}.jsonl`;
  const root = join(codexHome, 'sessions');
  let found: string | null = null;
  try {
    for (const year of readdirSync(root, { withFileTypes: true })) {
      if (!year.isDirectory() || found) continue;
      const yearDir = join(root, year.name);
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory() || found) continue;
        const monthDir = join(yearDir, month.name);
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory() || found) continue;
          const dayDir = join(monthDir, day.name);
          for (const file of readdirSync(dayDir)) {
            if (file.startsWith('rollout-') && file.endsWith(suffix)) {
              found = join(dayDir, file);
              break;
            }
          }
        }
      }
    }
  } catch {
    found = null;
  }

  // 只缓存命中结果：找不到时可能只是会话刚建、文件还没落盘，下次再查
  if (found) rolloutCache.set(sessionId, found);
  return found;
}

interface TokenEvent {
  cost: number;
  peak: boolean;
  input: number;
  cached: number;
  output: number;
}

interface Totals {
  amount: number;
  requests: number;
  input: number;
  cached: number;
  output: number;
  peakRequests: number;
}

interface FileState {
  /** 已解析到的字节偏移（只到最后一个完整行） */
  offset: number;
  model: string | null;
  /** 是否见过 task_started（老会话没有，需要用最后一次请求兜底） */
  sawTaskStart: boolean;
  /** 本回合的请求（遇 task_started 时清空） */
  roundEvents: TokenEvent[];
  lastEvent: TokenEvent | null;
  session: Totals;
}

const fileStates = new Map<string, FileState>();

function emptyTotals(): Totals {
  return {
    amount: 0,
    requests: 0,
    input: 0,
    cached: 0,
    output: 0,
    peakRequests: 0,
  };
}

function parseTokenEvent(line: string): {
  timestamp: string;
  input: number;
  cached: number;
  output: number;
} | null {
  try {
    const event = JSON.parse(line);
    const usage = event?.payload?.info?.last_token_usage;
    if (!usage || !event?.timestamp) return null;
    return {
      timestamp: event.timestamp,
      input: Number(usage.input_tokens ?? 0),
      cached: Number(usage.cached_input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
    };
  } catch {
    return null;
  }
}

function parseModel(line: string): string | null {
  try {
    return JSON.parse(line)?.payload?.model ?? null;
  } catch {
    return null;
  }
}

/** 把新增的完整行吃进 state（增量） */
function ingest(state: FileState, chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (!line) continue;
    if (line.includes('"turn_context"')) {
      state.model = parseModel(line) ?? state.model;
      continue;
    }
    if (line.includes('"task_started"')) {
      state.sawTaskStart = true;
      state.roundEvents = [];
      continue;
    }
    if (!line.includes('"token_count"')) continue;
    const raw = parseTokenEvent(line);
    if (!raw) continue;

    const turn = costOfTurn(raw, state.model, new Date(raw.timestamp));
    const event: TokenEvent = {
      cost: turn.cost,
      peak: turn.peak,
      input: raw.input,
      cached: Math.min(raw.cached, raw.input),
      output: raw.output,
    };
    state.lastEvent = event;
    state.roundEvents.push(event);
    state.session.amount += event.cost;
    state.session.requests += 1;
    state.session.input += event.input;
    state.session.cached += event.cached;
    state.session.output += event.output;
    if (event.peak) state.session.peakRequests += 1;
  }
}

/** 读到文件末尾，只处理完整行（增量） */
function refresh(rolloutPath: string, state: FileState): void {
  let size: number;
  try {
    size = statSync(rolloutPath).size;
  } catch {
    return;
  }
  // 文件被替换/截断：从头重来
  if (size < state.offset) {
    state.offset = 0;
    state.model = null;
    state.sawTaskStart = false;
    state.roundEvents = [];
    state.lastEvent = null;
    state.session = emptyTotals();
  }
  if (size === state.offset) return;

  const length = size - state.offset;
  const buffer = Buffer.alloc(length);
  let read = 0;
  const fd = openSync(rolloutPath, 'r');
  try {
    read = readSync(fd, buffer, 0, length, state.offset);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
  const chunk = buffer.subarray(0, read).toString('utf8');
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) return; // 还没有完整行
  const complete = chunk.slice(0, lastNewline + 1);
  state.offset += Buffer.byteLength(complete, 'utf8');
  ingest(state, complete);
}

/**
 * 计算花费：本回合 + 会话累计。
 * 解析失败 / 没有任何请求时返回 null（调用方静默跳过，不影响回复）。
 */
export function computeRoundCost(rolloutPath: string): RoundCost | null {
  let state = fileStates.get(rolloutPath);
  if (!state) {
    state = {
      offset: 0,
      model: null,
      sawTaskStart: false,
      roundEvents: [],
      lastEvent: null,
      session: emptyTotals(),
    };
    fileStates.set(rolloutPath, state);
  }
  refresh(rolloutPath, state);

  // 老会话没有 task_started：退回最后一次请求
  const events = state.sawTaskStart
    ? state.roundEvents
    : state.lastEvent
      ? [state.lastEvent]
      : [];
  if (!events.length || state.session.requests === 0) return null;

  let amount = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let peakRequests = 0;
  for (const event of events) {
    amount += event.cost;
    input += event.input;
    cached += event.cached;
    output += event.output;
    if (event.peak) peakRequests += 1;
  }

  return {
    amount,
    requests: events.length,
    input,
    cached,
    output,
    cachedRatio: input > 0 ? cached / input : 0,
    peakRequests,
    sessionAmount: state.session.amount,
    sessionRequests: state.session.requests,
    model: resolveModel(state.model),
  };
}

/**
 * 一行中文摘要，例如：
 * 💸 本回合 ¥0.078（4 次请求 · 缓存命中 99.5% · 高峰）· 会话累计 ¥12.31（465 次请求）
 */
export function formatCostLine(cost: RoundCost): string {
  const peakLabel =
    cost.peakRequests === cost.requests
      ? '高峰'
      : cost.peakRequests === 0
        ? '空闲'
        : `${cost.peakRequests}/${cost.requests} 次高峰`;
  const hit = (cost.cachedRatio * 100).toFixed(1);
  return (
    `💸 本回合 ${formatCny(cost.amount)}（${cost.requests} 次请求 · 缓存命中 ${hit}% · ${peakLabel}）` +
    ` · 会话累计 ${formatCny(cost.sessionAmount)}（${cost.sessionRequests} 次请求）`
  );
}

/** 便捷入口：按 thread id 直接算出可发送的一行；算不出来返回 null */
export function buildRoundCostLine(
  sessionId: string,
  codexHome?: string,
): string | null {
  const file = findRolloutFile(sessionId, codexHome);
  if (!file) return null;
  const cost = computeRoundCost(file);
  if (!cost) return null;
  return formatCostLine(cost);
}

/** 仅供测试：清掉增量解析缓存 */
export function resetCostCache(): void {
  fileStates.clear();
  rolloutCache.clear();
}
