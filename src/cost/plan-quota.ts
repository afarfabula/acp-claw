/**
 * 火山方舟 Coding Plan 套餐额度（5 小时 / 每周 / 每月）读取器。
 *
 * 数据来源：本机 arkcli 的控制面命令
 *   arkcli usage plan --product coding-plan --format json
 * 快照与火山方舟控制台「我的套餐」1:1（已用百分比 / 重置时间），需要 arkcli 已登录；
 * 查询失败时返回结构化 error，绝不抛出——调用方决定降级（例如只显示 token 数）。
 *
 * 与工作区工具 `tools/codex-cost/plan.mjs` 同一口径，且**共用同一份 TTL 缓存文件**
 * （~/.cache/codex-cost/coding-plan.json），避免状态栏和飞书两边各打一次网络。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CODING_PLAN_PRODUCT = 'coding-plan';
const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_TTL_MS = 120_000;

/** 套餐周期 label → 中文短标签 */
const PERIOD_LABELS: Record<string, string> = {
  session: '5小时',
  '5h': '5小时',
  daily: '当日',
  weekly: '本周',
  month: '本月',
  monthly: '本月',
};

export interface PlanPeriod {
  label: string;
  used: number | null;
  total: number | null;
  percent: number | null;
  resetAt: string | null;
}

export interface CodingPlan {
  ok: boolean;
  error: string | null;
  periods: PlanPeriod[];
  tier?: string | null;
  edition?: string | null;
  fetchedAt: string;
  cached?: boolean;
}

export function periodLabel(label?: string | null): string {
  const key = String(label ?? '');
  return PERIOD_LABELS[key] ?? key;
}

/** 候选 arkcli 可执行文件（按优先级） */
function arkcliCandidates(): string[] {
  const home = homedir();
  const list: string[] = [];
  if (process.env.ARKCLI_BIN) list.push(process.env.ARKCLI_BIN);
  list.push(
    join(home, '.local', 'node', 'bin', 'arkcli'),
    join(home, '.local', 'bin', 'arkcli'),
    '/usr/local/bin/arkcli',
    '/usr/bin/arkcli',
  );
  const pkgBin = join(
    home,
    '.local',
    'node',
    'lib',
    'node_modules',
    '@volcengine',
    'ark-cli',
    'bin',
  );
  list.push(
    join(pkgBin, 'arkcli-linux-amd64'),
    join(pkgBin, 'arkcli-linux-arm64'),
  );
  list.push('arkcli');
  return list;
}

function resolveArkcli(): string {
  // 显式指定的路径优先（测试 / 自定义安装位置时不再做存在性兜底）
  if (process.env.ARKCLI_BIN) return process.env.ARKCLI_BIN;
  for (const candidate of arkcliCandidates()) {
    if (candidate === 'arkcli') return candidate;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 忽略：继续找下一个候选
    }
  }
  return 'arkcli';
}

/** 归因环境变量：标记调用来源，冻结本次调用的 CLI 版本 */
function arkcliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARKCLI_NO_UPDATE_NOTIFIER: '1',
    ARKCLI_CALLER_TYPE: 'ai_agent',
    ARKCLI_CALLER_NAME: 'codex',
    ARKCLI_SKILL_NAME: 'arkcli-usage',
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePeriod(period?: {
  label?: unknown;
  used?: unknown;
  total?: unknown;
  percent?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
}): PlanPeriod {
  const used = numberOrNull(period?.used);
  const total = numberOrNull(period?.total);
  let percent = numberOrNull(period?.percent);
  if (percent === null && used !== null && total)
    percent = (used / total) * 100;
  const resetAt = period?.reset_at ?? period?.resetAt ?? null;
  return {
    label: String(period?.label ?? ''),
    used,
    total,
    percent: percent === null ? null : clamp(percent, 0, 100),
    resetAt: resetAt === null ? null : String(resetAt),
  };
}

/** 把 arkcli 的原始 JSON 规整成稳定结构 */
function normalizePlan(raw: unknown, product: string): CodingPlan {
  const empty: CodingPlan = {
    ok: false,
    error: 'arkcli 没有返回内容',
    periods: [],
    fetchedAt: new Date().toISOString(),
  };
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as {
    ok?: boolean;
    error?: { message?: string } | string;
    items?: Array<{
      product?: string;
      subscribed?: boolean;
      edition?: string;
      tier?: string;
      periods?: unknown[];
    }>;
  };
  if (data.ok === false) {
    return {
      ...empty,
      error:
        typeof data.error === 'string'
          ? data.error
          : (data.error?.message ?? 'arkcli 查询失败'),
    };
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const item =
    items.find((it) => it?.product === product) ??
    items.find((it) => it?.subscribed) ??
    items[0];
  if (!item) {
    return {
      ...empty,
      error: '没有找到 Coding Plan 订阅（可能未登录，或当前身份没有该套餐）',
    };
  }
  if (item.subscribed === false) {
    return { ...empty, error: `当前身份未订阅 ${product}` };
  }
  return {
    ok: true,
    error: null,
    edition: item.edition ?? null,
    tier: item.tier ?? null,
    periods: (item.periods ?? []).map((p) =>
      normalizePeriod(p as Parameters<typeof normalizePeriod>[0]),
    ),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchCodingPlan(
  product: string,
  timeoutMs: number,
): Promise<CodingPlan> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      resolveArkcli(),
      ['usage', 'plan', '--product', product, '--format', 'json'],
      { env: arkcliEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    const err = error as {
      stderr?: string;
      code?: string;
      killed?: boolean;
      message?: string;
    };
    const stderrText = String(err?.stderr ?? '').trim();
    const hint =
      /not configured|auth login|未登录/i.test(stderrText) ||
      err?.code === 'ENOENT'
        ? 'arkcli 未登录或未安装'
        : err?.killed
          ? 'arkcli 查询超时'
          : stderrText || err?.message || 'arkcli 调用失败';
    return {
      ok: false,
      error: hint,
      periods: [],
      fetchedAt: new Date().toISOString(),
    };
  }
  try {
    return normalizePlan(JSON.parse(stdout), product);
  } catch {
    return {
      ok: false,
      error: 'arkcli 输出不是合法 JSON',
      periods: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ---------- 缓存（每轮回复都要读，避免每轮都发一次网络） ----------

export function cacheFile(): string {
  const dir =
    process.env.CODEX_COST_CACHE || join(homedir(), '.cache', 'codex-cost');
  return join(dir, 'coding-plan.json');
}

function readCache(ttlMs: number): CodingPlan | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8')) as CodingPlan;
    if (!raw?.fetchedAt) return null;
    const age = Date.now() - new Date(raw.fetchedAt).getTime();
    if (!Number.isFinite(age) || age > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 读过期缓存（网络失败时的兜底，调用方自行标注「缓存」） */
export function readStaleCache(maxAgeMs = 24 * 3600_000): CodingPlan | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8')) as CodingPlan;
    if (!raw?.fetchedAt) return null;
    const age = Date.now() - new Date(raw.fetchedAt).getTime();
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(payload: CodingPlan): void {
  try {
    const file = cacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 写缓存失败不影响主流程
  }
}

/**
 * 带 TTL 缓存的读取入口。查询失败时退回「过期的旧缓存」并标 cached，
 * 都没有就返回 ok:false（调用方静默降级）。
 */
export async function loadPlan({
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  product = CODING_PLAN_PRODUCT,
}: {
  ttlMs?: number;
  timeoutMs?: number;
  product?: string;
} = {}): Promise<CodingPlan> {
  const cached = readCache(ttlMs);
  if (cached) return { ...cached, cached: true };

  const fresh = await fetchCodingPlan(product, timeoutMs);
  if (fresh.ok) {
    writeCache(fresh);
    return { ...fresh, cached: false };
  }
  const stale = readStaleCache();
  if (stale?.ok) return { ...stale, cached: true };
  return fresh;
}

// ---------- 渲染 ----------

/** reset_at（RFC3339）→ 北京时间；当天只给 HH:MM，跨天带上 M/D */
export function formatReset(
  resetAt: string | null,
  now: Date = new Date(),
): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  const fmt = (d: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      ...options,
    }).format(d);
  const time = fmt(date, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayKey = (d: Date) =>
    fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (dayKey(date) === dayKey(now)) return time;
  return `${fmt(date, { month: 'numeric', day: 'numeric' })} ${time}`;
}

/**
 * 飞书回复用的紧凑一行，例如：
 *   套餐 5小时 剩 18%（18:35 重置）· 本周 剩 79%（10-19 00:00 重置）· 本月 剩 91%
 * 按「还剩多少」口径展示（后端给的是已用百分比，这里换算成剩余）。
 */
export function renderQuotaLine(plan: CodingPlan): string | null {
  if (!plan.ok || !plan.periods.length) return null;
  const parts = plan.periods.map((period) => {
    const label = periodLabel(period.label);
    if (period.percent === null) return `${label} —`;
    const remain = Math.max(0, Math.min(100, Math.round(100 - period.percent)));
    const pct = `剩 ${remain}%`;
    const reset = formatReset(period.resetAt);
    return reset ? `${label} ${pct}（${reset} 重置）` : `${label} ${pct}`;
  });
  return `套餐 ${parts.join(' · ')}`;
}
