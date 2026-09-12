/**
 * 报表渲染：全部以人民币展示。
 */

import { formatCny, formatTokens } from './pricing.mjs';
import {
  beijingDay,
  collectTurns,
  groupByDay,
  groupBySession,
  summarize,
} from './usage.mjs';

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) =>
  COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
const bold = (text) => paint('1', text);
const dim = (text) => paint('2', text);

function line(char = '─', width = 62) {
  return char.repeat(width);
}

function header(title) {
  return `\n${bold(title)}\n${line()}`;
}

function totalsBlock(title, turns) {
  const total = summarize(turns);
  const rows = [
    ['轮次', String(total.turns)],
    [
      '输入',
      `${formatTokens(total.input)} tok（缓存命中 ${(total.cachedRatio * 100).toFixed(1)}%）`,
    ],
    ['输出', `${formatTokens(total.output)} tok`],
    ['花费', formatCny(total.cost)],
    ['高峰轮次', `${total.peakTurns}/${total.turns}`],
  ];
  const width = Math.max(...rows.map(([key]) => key.length));
  const body = rows
    .map(([key, value]) => `  ${key.padEnd(width)}  ${value}`)
    .join('\n');
  return `${header(title)}\n${body}\n`;
}

export function renderRange(label, { codexHome, from, to }) {
  const { turns, sessions } = collectTurns({ codexHome, from, to });
  const total = summarize(turns);
  const footer = dim(
    `  数据源 ${codexHome}/sessions（${sessions.size} 个会话文件，命中 ${total.cached} tok 缓存读取）`,
  );
  return `${totalsBlock(label, turns)}${footer}\n`;
}

export function renderDaily({ codexHome, from, to, limit = 14 }) {
  const { turns } = collectTurns({ codexHome, from, to });
  const days = [...groupByDay(turns).entries()].slice(-limit);
  if (!days.length) return '没有匹配的会话记录。\n';

  const rows = days.map(([day, dayTurns]) => {
    const total = summarize(dayTurns);
    return [
      day,
      String(total.turns),
      formatTokens(total.input),
      formatTokens(total.output),
      `${(total.cachedRatio * 100).toFixed(1)}%`,
      formatCny(total.cost),
    ];
  });

  const widths = [10, 6, 9, 8, 7, 10];
  const head = ['日期', '轮次', '输入', '输出', '命中', '花费'];
  const out = rows.map((row) =>
    row
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join('  '),
  );
  const headLine = head
    .map((cell, index) =>
      index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
    )
    .join('  ');

  const total = summarize(turns);
  return `${header('按日花费（人民币）')}\n${headLine}\n${out.join('\n')}\n${line()}\n  合计 ${formatCny(total.cost)} / ${total.turns} 轮 / 输入 ${formatTokens(total.input)} tok\n`;
}

export function renderSessions({ codexHome, from, to, limit = 15 }) {
  const { turns } = collectTurns({ codexHome, from, to });
  const sessions = [...groupBySession(turns).entries()];
  if (!sessions.length) return '没有匹配的会话记录。\n';

  const rows = sessions
    .map(([key, sessionTurns]) => {
      const total = summarize(sessionTurns);
      const lastTurn = sessionTurns.at(-1);
      return {
        key,
        cwd: shortenHome(lastTurn.cwd ?? '-'),
        total,
        last: lastTurn.timestamp,
      };
    })
    .sort((a, b) => b.total.cost - a.total.cost)
    .slice(0, limit);

  const body = rows.map((row) => {
    const stamp = new Date(row.last)
      .toISOString()
      .slice(5, 16)
      .replace('T', ' ');
    const id = row.key.slice(0, 8);
    return `  ${id}  ${stamp}  ${String(row.total.turns).padStart(4)} 轮  ${formatCny(row.total.cost).padStart(9)}  ${dim(row.cwd)}`;
  });
  const total = summarize(turns);
  return `${header('花费最高的会话（人民币）')}\n${body.join('\n')}\n${line()}\n  合计 ${formatCny(total.cost)} / ${sessions.length} 个会话\n`;
}

function shortenHome(path) {
  const home = process.env.HOME ?? '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function renderSummary({ codexHome }) {
  const now = new Date();
  const startOfDay = new Date(`${beijingDay(now)}T00:00:00+08:00`);
  const startOfMonth = new Date(
    `${beijingDay(now).slice(0, 7)}-01T00:00:00+08:00`,
  );
  const ranges = [
    ['今天', startOfDay, now],
    ['本月', startOfMonth, now],
    ['全部', null, null],
  ];
  const { turns } = collectTurns({ codexHome });
  const blocks = ranges.map(([label, from, to]) => {
    const subset = turns.filter((turn) => {
      const ts = new Date(turn.timestamp).getTime();
      if (from && ts < from.getTime()) return false;
      if (to && ts > to.getTime()) return false;
      return true;
    });
    const total = summarize(subset);
    return `  ${label.padEnd(4)}${formatCny(total.cost).padStart(10)}   ${String(total.turns).padStart(5)} 轮   ${formatTokens(total.input)} in / ${formatTokens(total.output)} out`;
  });
  return `${header('Codex 花费总览（人民币）')}\n${blocks.join('\n')}\n${dim(`  模型单价：flash 高峰 ¥2/¥8/¥0.04，空闲半价（元/百万 token；未命中/输出/缓存命中）`)}\n`;
}
