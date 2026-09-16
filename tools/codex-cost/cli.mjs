#!/usr/bin/env node

/**
 * codex-cost —— Codex 会话花费统计（人民币）
 *
 *   node cli.mjs summary              今天 / 本月 / 全部 总览
 *   node cli.mjs daily [天数]         按日明细
 *   node cli.mjs sessions [条数]      花费最高的会话
 *   node cli.mjs statusline           预览状态栏输出（用当前 Codex 会话）
 *   node cli.mjs install              安装 Stop hook（人民币状态栏）
 *   node cli.mjs uninstall            卸载 Stop hook
 *   node cli.mjs status               查看 hook 安装状态
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hookStatus, installHook, uninstallHook } from './hooks.mjs';
import {
  DEFAULT_MODEL,
  formatCny,
  formatTokens,
  isPeak,
  PRICING,
  rateFor,
} from './pricing.mjs';
import {
  renderDaily,
  renderRange,
  renderSessions,
  renderSummary,
} from './report.mjs';
import {
  collectTurns,
  defaultCodexHome,
  lastRound,
  parseRollout,
  summarize,
} from './usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STATUSLINE = join(here, 'statusline.mjs');

function nodePath() {
  return process.env.CODEX_COST_NODE || process.execPath;
}

function usage() {
  process.stdout.write(
    [
      'codex-cost —— Codex 花费统计（人民币）',
      '',
      '  summary              今天 / 本月 / 全部 总览',
      '  daily [天数]         按日明细（默认 14 天）',
      '  sessions [条数]      花费最高的会话（默认 15 条）',
      '  today                今天明细',
      '  month                本月明细',
      '  price                当前时段单价（是否高峰）',
      '  statusline           预览状态栏输出',
      '  install              安装 Stop hook（人民币状态栏）',
      '  uninstall            卸载 Stop hook',
      '  status               查看 hook 安装状态',
      '',
      `  数据源：${defaultCodexHome()}/sessions`,
      '',
    ].join('\n'),
  );
}

function previewStatusline(codexHome) {
  const { turns, sessions } = collectTurns({ codexHome });
  const lastSession = [...sessions.entries()].sort((a, b) => {
    const at = a[1].file;
    const bt = b[1].file;
    return String(bt).localeCompare(String(at));
  })[0];
  if (!lastSession) {
    process.stdout.write('没有找到会话记录。\n');
    return;
  }
  const parsed = parseRollout(lastSession[1].file);
  const last = parsed.turns.at(-1);
  const round = lastRound(parsed);
  const roundCost = round.turns.reduce((sum, turn) => sum + turn.cost, 0);
  const total = summarize(parsed.turns);
  const roundText = round.isComplete
    ? `本回合 ${formatCny(roundCost)}（${round.turns.length} 次请求）`
    : `本轮 ${formatCny(last?.cost ?? 0)}（单次请求）`;
  process.stdout.write(
    `会话 ${parsed.sessionId ?? '-'}  文件 ${lastSession[1].file}\n` +
      `  ${roundText}  会话合计 ${formatCny(total.cost)}  ` +
      `输入 ${formatTokens(total.input)} tok（命中 ${(total.cachedRatio * 100).toFixed(1)}%）  输出 ${formatTokens(total.output)} tok\n` +
      `  共 ${turns.length} 轮（全部会话）\n`,
  );
}

function printPrice() {
  const now = new Date();
  const { peakLabel } = rateFor(DEFAULT_MODEL, now);
  process.stdout.write(
    `当前时段：${peakLabel}（北京市 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）\n` +
      '单价 元/百万 token（未命中输入 / 输出 / 缓存命中）：\n',
  );
  for (const table of Object.values(PRICING)) {
    const tier = isPeak(now) ? table.peak : table.offPeak;
    process.stdout.write(
      `  ${table.label.padEnd(20)} ¥${tier.input} / ¥${tier.output} / ¥${tier.cacheRead}\n`,
    );
  }
  process.stdout.write(
    '高峰时段：北京时间周一至周五 09:00-12:00、14:00-18:00；其余时段与周末为半价\n',
  );
}

function main() {
  const [command = 'summary', ...args] = process.argv.slice(2);
  const codexHome = defaultCodexHome();
  const now = new Date();

  switch (command) {
    case 'summary':
      process.stdout.write(renderSummary({ codexHome }));
      break;
    case 'daily':
      process.stdout.write(
        renderDaily({ codexHome, limit: Number(args[0]) || 14 }),
      );
      break;
    case 'sessions':
      process.stdout.write(
        renderSessions({ codexHome, limit: Number(args[0]) || 15 }),
      );
      break;
    case 'today': {
      const day = new Date(`${beijingDayOf(now)}T00:00:00+08:00`);
      process.stdout.write(
        renderRange(`今天（${beijingDayOf(now)}）`, {
          codexHome,
          from: day,
          to: now,
        }),
      );
      break;
    }
    case 'month': {
      const month = new Date(
        `${beijingDayOf(now).slice(0, 7)}-01T00:00:00+08:00`,
      );
      process.stdout.write(
        renderRange(`本月（${beijingDayOf(now).slice(0, 7)}）`, {
          codexHome,
          from: month,
          to: now,
        }),
      );
      break;
    }
    case 'price':
      printPrice();
      break;
    case 'statusline':
      previewStatusline(codexHome);
      break;
    case 'install': {
      const file = installHook({
        codexHome,
        nodePath: nodePath(),
        scriptPath: STATUSLINE,
      });
      process.stdout.write(
        `已写入 ${file}\n` +
          `  Stop hook → ${nodePath()} ${STATUSLINE}\n` +
          '  下一步：在 Codex 里执行 /hooks 信任该 hook，然后重启 Codex\n',
      );
      break;
    }
    case 'uninstall': {
      const file = uninstallHook({ codexHome });
      process.stdout.write(
        file ? `已从 ${file} 移除 codex-cost hook\n` : '未找到 hooks.json\n',
      );
      break;
    }
    case 'status': {
      const entries = hookStatus({ codexHome });
      if (!entries.length) {
        process.stdout.write('未安装 Stop hook。\n');
        break;
      }
      for (const entry of entries) {
        process.stdout.write(
          `${entry.ours ? '[本工具]' : '[其它]'} ${entry.command}\n`,
        );
      }
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      process.stderr.write(`未知命令：${command}\n\n`);
      usage();
      process.exitCode = 1;
  }
}

function beijingDayOf(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

main();
