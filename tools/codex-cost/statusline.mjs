#!/usr/bin/env node
/**
 * Codex Stop hook：每轮回答结束后，在回答尾部追加一行人民币花费状态栏。
 *
 * 由 ~/.codex/hooks.json 调用，stdin 收到 Codex 的 hook 事件 JSON：
 *   { session_id, transcript_path, hook_event_name, cwd, model, ... }
 * stdout 输出 { "systemMessage": "..." }，Codex 会把它渲染到对话里（不进模型上下文）。
 */

import { basename } from 'node:path';

import { DEFAULT_MODEL, formatCny, formatTokens } from './pricing.mjs';
import { parseRollout } from './usage.mjs';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const color = (rgb, text) => `\u001b[38;2;${rgb}m${text}${RESET}`;
const GREEN = '166;227;161';
const PEACH = '250;179;135';
const PINK = '243;139;168';
const MAUVE = '203;166;247';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function bar(ratio, width = 8) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

async function main() {
  const payload = parsePayload(await readStdin());
  const transcript = payload.transcript_path ?? payload.transcriptPath;
  if (!transcript) return; // 没有会话记录就不显示，静默退出

  let session;
  try {
    session = parseRollout(transcript);
  } catch {
    return;
  }
  if (!session.turns.length) return;

  const turns = session.turns;
  const last = turns.at(-1);
  const sessionCost = turns.reduce((sum, turn) => sum + turn.cost, 0);
  const sessionTokens = turns.reduce(
    (sum, turn) => sum + turn.usage.input + turn.usage.output,
    0,
  );
  const listed = turns.filter((turn) => turn.peak).length;

  const project = basename(payload.cwd ?? session.cwd ?? process.cwd());
  const model = session.model ?? DEFAULT_MODEL;
  const contextWindow = session.contextWindow ?? 0;
  const usedRatio = contextWindow > 0 ? last.usage.input / contextWindow : 0;

  const line1 = [
    color(GREEN, `[${project}]`),
    `${DIM}本轮${RESET} ${color(PEACH, formatCny(last.cost))}`,
    `${DIM}会话${RESET} ${color(PINK, formatCny(sessionCost))}`,
    `${DIM}累计${RESET} ${formatTokens(sessionTokens)} tok`,
    `${DIM}${model}${RESET}`,
  ].join(' | ');

  const line2 = [
    `${DIM}上下文${RESET} ${formatTokens(last.usage.input)}/${formatTokens(contextWindow)} ${bar(usedRatio)} ${(usedRatio * 100).toFixed(0)}%`,
    `${DIM}缓存命中${RESET} ${(last.cachedRatio * 100).toFixed(1)}%`,
    `${DIM}${listed}/${turns.length} 轮高峰${RESET}`,
  ].join(' | ');

  const text = `\n${line1}\n${color(MAUVE, line2)}`;
  process.stdout.write(JSON.stringify({ systemMessage: text }));
}

main().catch(() => {
  // hook 失败绝不打断 Codex
  process.exit(0);
});
