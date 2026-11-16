import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expandHome, localParts, resolveDataDir } from './state.mjs';
import { sendImageMessage } from './feishu.mjs';

const CHART_SCRIPT = new URL('./mail-chart.py', import.meta.url).pathname;
const DEFAULT_LEDGER_CONFIG = join(
  homedir(),
  '.acp-claw',
  'cmb-ledger',
  'config.json',
);
const DEFAULT_LEDGER_CLI = join(
  homedir(),
  '.acp-claw',
  'tools',
  'cmb-ledger',
  'cli.mjs',
);
const COLORS = [
  '#2563eb',
  '#16a34a',
  '#8b5cf6',
  '#f59e0b',
  '#ef4444',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#7c3aed',
  '#0f766e',
];

function money(value) {
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function utcDateFromIso(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function previousDate(date) {
  const value = utcDateFromIso(date);
  value.setUTCDate(value.getUTCDate() - 1);
  return isoDate(value);
}

export function billPeriods(now, timeZone = 'Asia/Shanghai') {
  const parts = localParts(now, timeZone);
  return {
    today: parts.date,
    yesterday: previousDate(parts.date),
    monthStart: `${parts.month}-01`,
  };
}

function ledgerCategoryLabel(ledger, account) {
  const entry = Object.entries(ledger.categoryAccounts || {}).find(
    ([, value]) => value === account,
  );
  return entry?.[0] || account.split(':').at(-1) || '未分类';
}

function categoryItems(summary, ledger) {
  return (summary.categories || [])
    .map((row) => ({
      label: ledgerCategoryLabel(ledger, row.account),
      value: roundMoney(Number(row.amountCents || 0) / 100),
    }))
    .filter((row) => Number.isFinite(row.value) && row.value > 0)
    .sort((left, right) => right.value - left.value)
    .map((row, index) => ({
      ...row,
      color: COLORS[index % COLORS.length],
    }));
}

export function summarizeText(summary, items, label) {
  const spend = roundMoney(Number(summary.spendCents || 0) / 100);
  const refund = roundMoney(Number(summary.refundCents || 0) / 100);
  const top = items.slice(0, 3);
  const itemTotal = items.reduce((sum, item) => sum + item.value, 0);
  const detail = top.length
    ? top
      .map((item) => {
        const percent = itemTotal > 0 ? (item.value / itemTotal) * 100 : 0;
        return `${item.label} ¥${money(item.value)}（${percent.toFixed(0)}%）`;
      })
      .join('、')
    : '无消费记录';
  const refundText = refund > 0 ? `，退款 ¥${money(refund)}` : '';
  const provisional = Number(summary.provisionalCount || 0);
  const provisionalText = provisional > 0 ? `，含 ${provisional} 笔待月账确认` : '';
  return `${label}消费 ¥${money(spend)}${refundText}；主要：${detail}${provisionalText}`;
}

async function runLedgerSummaries(ledgerCli, ledgerConfigPath, ranges) {
  const ledgerLibPath = join(dirname(ledgerCli), 'lib.mjs');
  let ledgerLib;
  try {
    ledgerLib = await import(pathToFileURL(ledgerLibPath).href);
  } catch (error) {
    throw new Error(`加载账单工具失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = ledgerLib.appPaths(dirname(ledgerConfigPath));
  const db = ledgerLib.openStore(paths);
  try {
    const ledger = ledgerLib.ensureAppConfig(paths);
    return ranges.map(({ from, to }) => (
      ledgerLib.buildSummary(db, ledger, { from, to })
    ));
  } finally {
    db.close();
  }
}

async function renderAndSendChart({
  cfg,
  parts,
  daily,
  items,
  flags,
}) {
  const dataDir = resolveDataDir(cfg);
  mkdirSync(dataDir, { recursive: true });
  const pngPath = join(
    dataDir,
    `${parts.date}-bill-daily-${daily.date}.png`,
  );
  const inputPath = join(dataDir, `.bill-chart-${process.pid}.json`);
  const chartTotal = roundMoney(items.reduce((sum, item) => sum + item.value, 0));
  let chartGenerated = false;
  let chartSent = false;
  let chartError = null;
  let chartDeleted = false;

  try {
    writeFileSync(
      inputPath,
      JSON.stringify(
        {
          title: `${cfg.bill?.chartTitle ?? '消费分类'} · ${daily.date}`,
          subtitle: `${parts.stamp} · 合计 ¥${money(chartTotal)}`,
          totalLabel: money(chartTotal),
          unit: '元',
          valueFormat: 'money',
          items,
          footer: '数据源：本地招商银行信用卡账本（昨日消费）',
        },
        null,
        2,
      ),
      'utf-8',
    );
    const chart = spawnSync('python3', [CHART_SCRIPT, inputPath, pngPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    // 某些沙箱会给成功的子进程错误挂一个 EPERM；以退出码和输出文件为准。
    if (chart.status !== 0 || !existsSync(pngPath)) {
      throw new Error(
        `账单饼图生成失败: ${`${chart.stdout || ''}\n${chart.stderr || ''}`.trim()}`,
      );
    }
    chartGenerated = true;

    if (flags['send-chat'] || flags['send-open-id']) {
      try {
        const receiveId = flags['send-chat'] || flags['send-open-id'];
        const receiveType = flags['send-chat'] ? 'chat_id' : 'open_id';
        await sendImageMessage(receiveId, pngPath, receiveType);
        chartSent = true;
      } catch (error) {
        chartError = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    for (const path of [inputPath, pngPath]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        chartError = [chartError, `临时文件清理失败: ${String(error)}`]
          .filter(Boolean)
          .join('；');
      }
    }
    chartDeleted = !existsSync(pngPath);
  }

  return { chartGenerated, chartSent, chartError, chartDeleted };
}

/**
 * 每日早上生成昨日消费饼图；其他时段只输出文字。
 * `--daily-chart` 才绘制图片，避免 12/18 点重复生成月图。
 */
export async function collectBillReport(cfg, flags = {}) {
  const now = new Date();
  const parts = localParts(now, cfg.timezone);
  const periods = billPeriods(now, cfg.timezone);
  const dailyDate = typeof flags.date === 'string'
    ? flags.date
    : periods.yesterday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dailyDate)) {
    throw new Error('--date 必须是 YYYY-MM-DD');
  }
  const ledgerConfigPath = expandHome(
    flags.config ?? cfg.bill?.ledgerConfig ?? DEFAULT_LEDGER_CONFIG,
  );
  const ledger = JSON.parse(readFileSync(ledgerConfigPath, 'utf8'));
  const ledgerCli = expandHome(
    flags['ledger-cli'] ?? cfg.bill?.ledgerCli ?? DEFAULT_LEDGER_CLI,
  );
  const ledgerLibPath = join(dirname(ledgerCli), 'lib.mjs');
  if (!existsSync(ledgerCli) || !existsSync(ledgerLibPath)) {
    throw new Error(`账单工具不存在：${ledgerCli}`);
  }

  const [dailySummary, monthlySummary] = await runLedgerSummaries(
    ledgerCli,
    ledgerConfigPath,
    [
      { from: dailyDate, to: dailyDate },
      { from: periods.monthStart, to: periods.today },
    ],
  );
  const dailyItems = categoryItems(dailySummary, ledger);
  const monthlyItems = categoryItems(monthlySummary, ledger);
  const dailyText = summarizeText(
    dailySummary,
    dailyItems,
    `昨日（${dailyDate.slice(5)}）`,
  );
  const monthlyText = summarizeText(
    monthlySummary,
    monthlyItems,
    '本月至今',
  );

  const chartRequested = Boolean(flags['daily-chart']);
  const chartResult = chartRequested
    ? await renderAndSendChart({
      cfg,
      parts,
      daily: { date: dailyDate },
      items: dailyItems,
      flags,
    })
    : {
      chartGenerated: false,
      chartSent: false,
      chartError: null,
      chartDeleted: true,
    };
  const markdown = `💳 ${dailyText}\n${monthlyText}`;
  const dataDir = resolveDataDir(cfg);
  const jsonPath = join(
    dataDir,
    `${parts.date}-bill-${parts.time.replace(':', '')}.json`,
  );
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        periods: { ...periods, dailyDate },
        daily: {
          spend: roundMoney(dailySummary.spendCents / 100),
          refund: roundMoney(dailySummary.refundCents / 100),
          transactionCount: dailySummary.transactionCount,
          provisionalCount: dailySummary.provisionalCount,
          items: dailyItems,
        },
        monthly: {
          spend: roundMoney(monthlySummary.spendCents / 100),
          refund: roundMoney(monthlySummary.refundCents / 100),
          transactionCount: monthlySummary.transactionCount,
          provisionalCount: monthlySummary.provisionalCount,
          items: monthlyItems,
        },
        chartRequested,
        ...chartResult,
        markdown,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    jsonPath,
    ...chartResult,
    dailyText,
    monthlyText,
    markdown,
  };
}
