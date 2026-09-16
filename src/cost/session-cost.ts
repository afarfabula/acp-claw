/**
 * 按 Codex 会话记录（codexHome/sessions/年/月/日/rollout-时间-线程id.jsonl）算「本回合」花费。
 *
 * 一次用户输入（一个回合）会引发多次模型请求：模型 → 工具调用 → 模型 → … → 最终回答，
 * 每次都要重发上下文并单独计费。Codex 在每回合开头写一条 task_started，
 * 因此本回合花费 = 该时间点之后所有 token_count 事件（缓存命中价 + 未命中价 + 输出价）之和。
 *
 * 与工作区工具 tools/codex-cost 的 lastRound() 同一算法；这里只扫文件尾部，
 * 避免每回合解析整个会话文件（长会话能到几 MB）。
 */

import { readdirSync, readFileSync } from 'node:fs';
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
  /** 缓存命中率（0-1） */
  cachedRatio: number;
  /** 命中高峰价的请求数 */
  peakRequests: number;
  model: string;
}

export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** sessionId（= Codex thread id，即 acpSessionId）→ rollout 文件路径 */
const rolloutCache = new Map<string, string | null>();

/**
 * 按 thread id 找会话记录文件。
 * 文件名形如 rollout-2026-08-30T22-16-14-<threadId>.jsonl，位于 sessions/年/月/日 下。
 */
export function findRolloutFile(
  sessionId: string,
  codexHome: string = codexHomeDir(),
): string | null {
  const cached = rolloutCache.get(sessionId);
  if (cached !== undefined) return cached;

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
  timestamp: string;
  input: number;
  cached: number;
  output: number;
}

/**
 * 计算最后一个回合的花费。
 * 解析失败 / 没有任何请求时返回 null（调用方静默跳过，不影响回复）。
 */
export function computeRoundCost(rolloutPath: string): RoundCost | null {
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }

  // 只解析最后一个回合：定位最后一条 task_started，从该行开始扫；
  // 没有 task_started（老会话）时退回最后一个 token_count 事件（即最后一次请求）。
  const startMarker = raw.lastIndexOf('"task_started"');
  const fallbackMarker = raw.lastIndexOf('"token_count"');
  const marker = startMarker >= 0 ? startMarker : fallbackMarker;
  if (marker < 0) return null;

  // 模型名取最近一次 turn_context（同一回合内不会换模型）
  let model: string | null = null;
  const ctxMarker = raw.lastIndexOf('"turn_context"', marker);
  if (ctxMarker >= 0) {
    const ctxStart = raw.lastIndexOf('\n', ctxMarker) + 1;
    const ctxEnd = raw.indexOf('\n', ctxMarker);
    model = parseModel(raw.slice(ctxStart, ctxEnd < 0 ? undefined : ctxEnd));
  }

  const lineStart = raw.lastIndexOf('\n', marker) + 1;
  const events: TokenEvent[] = [];
  for (const line of raw.slice(lineStart).split('\n')) {
    if (!line) continue;
    if (line.includes('"task_started"')) continue;
    if (!line.includes('"token_count"')) continue;
    const event = parseTokenEvent(line);
    if (event) events.push(event);
  }
  if (!events.length) return null;

  let amount = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let peakRequests = 0;
  for (const event of events) {
    const turn = costOfTurn(event, model, new Date(event.timestamp));
    amount += turn.cost;
    input += event.input;
    cached += event.cached;
    output += event.output;
    if (turn.peak) peakRequests += 1;
  }

  return {
    amount,
    requests: events.length,
    input,
    cached,
    output,
    cachedRatio: input > 0 ? cached / input : 0,
    peakRequests,
    model: resolveModel(model),
  };
}

function parseModel(line?: string): string | null {
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    return event?.payload?.model ?? null;
  } catch {
    return null;
  }
}

function parseTokenEvent(line: string): TokenEvent | null {
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

/** 一行中文摘要，例如：💸 本回合 ¥0.078（4 次请求 · 缓存命中 99.5% · 高峰） */
export function formatCostLine(cost: RoundCost): string {
  const peakLabel =
    cost.peakRequests === cost.requests
      ? '高峰'
      : cost.peakRequests === 0
        ? '空闲'
        : `${cost.peakRequests}/${cost.requests} 次高峰`;
  const hit = (cost.cachedRatio * 100).toFixed(1);
  return `💸 本回合 ${formatCny(cost.amount)}（${cost.requests} 次请求 · 缓存命中 ${hit}% · ${peakLabel}）`;
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
