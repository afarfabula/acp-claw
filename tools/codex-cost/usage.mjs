/**
 * 从 Codex 本地会话记录（~/.codex/sessions/**\/rollout-*.jsonl）里
 * 提取逐轮 token 用量，并按人民币计价。
 *
 * 每条 token_count 事件的 info.last_token_usage 就是一轮的用量：
 *   { input_tokens, cached_input_tokens, output_tokens, ... }
 * 同一条记录里 turn_context.model 给出该轮实际使用的模型。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { costOfTurn } from './pricing.mjs';

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** 递归找 sessions/ 下的 rollout 文件 */
export function listRollouts(codexHome = defaultCodexHome()) {
  const root = join(codexHome, 'sessions');
  const files = [];
  let years;
  try {
    years = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearDir = join(root, year.name);
    for (const month of readdirSync(yearDir, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthDir = join(yearDir, month.name);
      for (const day of readdirSync(monthDir, { withFileTypes: true })) {
        if (!day.isDirectory()) continue;
        const dayDir = join(monthDir, day.name);
        for (const file of readdirSync(dayDir)) {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
            files.push(join(dayDir, file));
          }
        }
      }
    }
  }
  return files.sort();
}

/**
 * 解析单个 rollout 文件，返回该会话的逐轮用量。
 * 返回 { sessionId, cwd, turns: [{ timestamp, model, usage, cost, peak, cachedRatio }] }
 */
export function parseRollout(file) {
  const raw = readFileSync(file, 'utf8');
  let sessionId = null;
  let cwd = null;
  let model = null;
  let contextWindow = null;
  const turns = [];
  const roundStarts = [];

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session_meta') {
      sessionId = event.payload?.id ?? event.payload?.session_id ?? sessionId;
      cwd = event.payload?.cwd ?? cwd;
      continue;
    }
    if (event.type === 'turn_context') {
      model = event.payload?.model ?? model;
      continue;
    }
    if (event.type !== 'event_msg') continue;
    const payload = event.payload;
    // 回合边界：一次用户输入 = 一条 task_started，其后所有 token_count 同属该回合
    if (payload?.type === 'task_started') {
      roundStarts.push(event.timestamp);
      continue;
    }
    if (payload?.type !== 'token_count') continue;
    const usage = payload.info?.last_token_usage;
    if (!usage) continue;
    contextWindow = payload.info?.model_context_window ?? contextWindow;

    const timestamp = event.timestamp;
    const cost = costOfTurn(usage, model, new Date(timestamp));
    const input = Number(usage.input_tokens ?? 0);
    turns.push({
      timestamp,
      sessionId,
      file,
      cwd,
      model: cost.model,
      peak: cost.peak,
      usage: {
        input,
        cached: Number(usage.cached_input_tokens ?? 0),
        output: Number(usage.output_tokens ?? 0),
        reasoning: Number(usage.reasoning_output_tokens ?? 0),
      },
      cost: cost.cost,
      cachedRatio:
        input > 0 ? Number(usage.cached_input_tokens ?? 0) / input : 0,
    });
  }

  return { sessionId, cwd, model, contextWindow, turns, roundStarts };
}

/**
 * 最后一个「回合」的请求集合。
 *
 * 一次用户输入（一个回合）会引发多次请求：模型 → 工具调用 → 模型 → … → 最终回答，
 * 每次都要重发上下文并单独计费。Codex 在每回合开头写一条 task_started，
 * 所以「本回合花费」应是最后一次 task_started 之后全部 token_count 之和。
 *
 * 老会话没有 task_started 记录时退回最后一次请求，并以 isComplete=false 标记
 * （此时只能当「本轮/最后一次请求」看，不能当回合花费看）。
 */
export function lastRound(parsed) {
  const turns = parsed?.turns ?? [];
  if (!turns.length) return { turns: [], isComplete: false };
  const starts = parsed?.roundStarts ?? [];
  const start = starts.length ? starts[starts.length - 1] : null;
  const fallback = { turns: [turns[turns.length - 1]], isComplete: false };
  if (!start) return fallback;
  const startMs = new Date(start).getTime();
  const inRound = turns.filter((t) => new Date(t.timestamp).getTime() >= startMs);
  return inRound.length ? { turns: inRound, isComplete: true } : fallback;
}

/** 收集一段时间内的所有轮次（按事件时间过滤） */
export function collectTurns({
  codexHome = defaultCodexHome(),
  from,
  to,
  files,
} = {}) {
  const targets = files ?? listRollouts(codexHome);
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const turns = [];
  const sessions = new Map();

  for (const file of targets) {
    let parsed;
    try {
      parsed = parseRollout(file);
    } catch {
      continue;
    }
    sessions.set(parsed.sessionId ?? file, { cwd: parsed.cwd, file, turns: 0 });
    for (const turn of parsed.turns) {
      const ts = new Date(turn.timestamp).getTime();
      if (ts < fromMs || ts > toMs) continue;
      turns.push(turn);
      sessions.get(parsed.sessionId ?? file).turns += 1;
    }
  }

  turns.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { turns, sessions };
}

export function summarize(turns) {
  const total = {
    turns: turns.length,
    input: 0,
    cached: 0,
    miss: 0,
    output: 0,
    cost: 0,
    peakTurns: 0,
  };
  for (const turn of turns) {
    total.input += turn.usage.input;
    total.cached += turn.usage.cached;
    total.miss += Math.max(turn.usage.input - turn.usage.cached, 0);
    total.output += turn.usage.output;
    total.cost += turn.cost;
    if (turn.peak) total.peakTurns += 1;
  }
  total.cachedRatio = total.input > 0 ? total.cached / total.input : 0;
  return total;
}

/** 按北京时间分日聚合 */
export function groupByDay(turns) {
  const days = new Map();
  for (const turn of turns) {
    const day = beijingDay(turn.timestamp);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(turn);
  }
  return new Map([...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function groupBySession(turns) {
  const sessions = new Map();
  for (const turn of turns) {
    const key = turn.sessionId ?? turn.file;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(turn);
  }
  return sessions;
}

export function beijingDay(value) {
  const date = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
