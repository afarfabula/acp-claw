/**
 * 火山方舟 Coding Plan 套餐额度（5 小时 / 每周 / 每月）读取器。
 *
 * 数据来源：本机 arkcli 的控制面命令
 *   arkcli usage plan --product coding-plan --format json
 * 这份快照跟火山方舟控制台「我的套餐」1:1（已用百分比 / 重置时间），
 * 需要 arkcli 已登录（SSO）；未登录 / 失败时返回结构化 error，绝不抛出，
 * 由调用方决定怎么降级。
 *
 * 设计要点：
 * - 优先用本机已安装的 arkcli（npm 全局 bin → PATH → vendor 兜底）
 * - 调用带 arkcli-shared 约定的归因环境变量：冻结版本、不触发隐式更新检查
 * - 结果可带 TTL 缓存：状态栏每轮都要读，避免每轮都发一次网络请求
 * - 解析容错：Coding Plan 后端只保证 `percent`，`used` / `total` 可能缺失
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CODING_PLAN_PRODUCT = 'coding-plan';
const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_TTL_MS = 120_000;

/** 套餐周期 label → 中文短标签 */
const PERIOD_LABELS = {
  session: '5小时',
  '5h': '5小时',
  daily: '当日',
  weekly: '本周',
  month: '本月',
  monthly: '本月',
};

export function periodLabel(label) {
  const key = String(label ?? '');
  return PERIOD_LABELS[key] ?? key;
}

/** 候选 arkcli 可执行文件（按优先级，前面优先） */
export function arkcliCandidates() {
  const home = homedir();
  const list = [];
  if (process.env.ARKCLI_BIN) list.push(process.env.ARKCLI_BIN);
  list.push(
    join(home, '.local', 'node', 'bin', 'arkcli'),
    join(home, '.local', 'bin', 'arkcli'),
    '/usr/local/bin/arkcli',
    '/usr/bin/arkcli',
  );
  // npm 全局包里的原始二进制（bin 软链缺失时兜底）
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
    join(pkgBin, 'arkcli-darwin-arm64'),
    join(pkgBin, 'arkcli-darwin-amd64'),
  );
  list.push('arkcli'); // 最后退回 PATH 查找
  return list;
}

/** 解析出实际可用的 arkcli 路径（找不到时退回 'arkcli'，交给 PATH/spawn 报错） */
export function resolveArkcli() {
  for (const candidate of arkcliCandidates()) {
    if (candidate === 'arkcli') return candidate;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return 'arkcli';
}

/** 归因环境变量：标记调用来源，冻结本次 workflow 的 CLI 版本 */
function arkcliEnv() {
  return {
    ...process.env,
    ARKCLI_NO_UPDATE_NOTIFIER: '1',
    ARKCLI_CALLER_TYPE: 'ai_agent',
    ARKCLI_CALLER_NAME: 'codex',
    ARKCLI_SKILL_NAME: 'arkcli-usage',
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function normalizePeriod(period) {
  const used = numberOrNull(period?.used);
  const total = numberOrNull(period?.total);
  let percent = numberOrNull(period?.percent);
  if (percent === null && used !== null && total)
    percent = (used / total) * 100;
  return {
    label: String(period?.label ?? ''),
    used,
    total,
    percent: percent === null ? null : clamp(percent, 0, 100),
    resetAt: period?.reset_at ?? period?.resetAt ?? null,
  };
}

/**
 * 把 arkcli 的原始 JSON 规整成稳定结构。
 * 兼容两种形态：成功 { viewer, items:[...] }；失败 { ok:false, error:{...} }。
 */
export function normalizePlan(raw, product = CODING_PLAN_PRODUCT) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'arkcli 没有返回内容' };
  }
  if (raw.ok === false) {
    return {
      ok: false,
      error: raw.error?.message || raw.error || 'arkcli 查询失败',
      viewer: raw.viewer ?? null,
      raw,
    };
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  const item =
    items.find((it) => it?.product === product) ??
    items.find((it) => it?.subscribed) ??
    items[0] ??
    null;
  if (!item) {
    return {
      ok: false,
      error: '没有找到 Coding Plan 订阅（可能未登录，或当前身份没有该套餐）',
      viewer: raw.viewer ?? null,
      raw,
    };
  }
  if (item.subscribed === false) {
    return {
      ok: false,
      error: `当前身份未订阅 ${product}`,
      viewer: raw.viewer ?? null,
      item,
      raw,
    };
  }
  return {
    ok: true,
    viewer: raw.viewer ?? null,
    product: item.product ?? product,
    edition: item.edition ?? null,
    tier: item.tier ?? null,
    seatId: item.seat_id ?? null,
    periods: (item.periods ?? []).map(normalizePeriod),
    resetAt: item.reset_at ?? null,
    updatedAt: item.updated_at ?? raw.updated_at ?? null,
    error: null,
    raw,
  };
}

/**
 * 拉取一次 Coding Plan 额度快照。
 * @returns {Promise<object>} normalizePlan(...) 的结果，另加 { fetchedAt }
 */
export async function fetchCodingPlan({
  bin,
  product = CODING_PLAN_PRODUCT,
  all = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const arkcli = bin ?? resolveArkcli();
  const args = ['usage', 'plan', '--format', 'json'];
  if (all) args.push('--all');
  else if (product) args.push('--product', product);

  let stdout;
  try {
    ({ stdout } = await execFileAsync(arkcli, args, {
      env: arkcliEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const stderrText = String(error?.stderr ?? '').trim();
    const hint =
      /not configured|auth login|未登录/i.test(stderrText) ||
      error?.code === 'ENOENT'
        ? 'arkcli 未登录或未安装（先跑 arkcli auth login）'
        : error?.killed
          ? 'arkcli 查询超时'
          : stderrText || error?.message || 'arkcli 调用失败';
    return { ok: false, error: hint, fetchedAt: new Date().toISOString() };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: 'arkcli 输出不是合法 JSON',
      fetchedAt: new Date().toISOString(),
    };
  }
  return {
    ...normalizePlan(parsed, product),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- 缓存（状态栏每轮都读，避免每轮打一次网络） ----------

export function cacheFile() {
  const dir =
    process.env.CODEX_COST_CACHE || join(homedir(), '.cache', 'codex-cost');
  return join(dir, 'coding-plan.json');
}

export function readCache(ttlMs = DEFAULT_TTL_MS) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    if (!raw?.fetchedAt) return null;
    const age = Date.now() - new Date(raw.fetchedAt).getTime();
    if (!Number.isFinite(age) || age > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeCache(payload) {
  try {
    const file = cacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 写缓存失败不影响主流程
  }
}

/** 带 TTL 缓存的读取入口（force=true 时忽略缓存，强制刷新） */
export async function loadPlan({
  ttlMs = DEFAULT_TTL_MS,
  force = false,
  bin,
  product = CODING_PLAN_PRODUCT,
  all = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!force) {
    const cached = readCache(ttlMs);
    if (cached) return { ...cached, cached: true };
  }
  const result = await fetchCodingPlan({ bin, product, all, timeoutMs });
  writeCache(result);
  return { ...result, cached: false };
}

// ---------- 渲染 ----------

export function barText(percent, width = 10) {
  const ratio = percent === null || percent === undefined ? 0 : percent / 100;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** reset_at（RFC3339）→ 北京时间；当天只给 HH:MM，跨天带上 M/D */
export function formatReset(resetAt, now = new Date()) {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  const fmt = (d, options) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      ...options,
    }).format(d);
  const time = fmt(date, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayKey = (d) =>
    fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (dayKey(date) === dayKey(now)) return time;
  return `${fmt(date, { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** 「距重置还有 2h33m」 */
export function untilReset(resetAt, now = new Date()) {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return '已重置';
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

/**
 * 状态栏用的紧凑一行，例如：
 *   套餐 5小时  82% ████████░░（18:35 重置）  本周  21% ██░░░░░░░░  本月  9% █░░░░░░░░
 */
export function renderQuotaLine(
  plan,
  { width = 10, includeReset = true } = {},
) {
  if (!plan?.ok || !plan.periods?.length) return null;
  const parts = plan.periods.map((period) => {
    const label = periodLabel(period.label);
    if (period.percent === null) return `${label}    — ${barText(0, width)}`;
    const pct = Math.round(period.percent);
    const bar = barText(period.percent, width);
    const reset = includeReset ? formatReset(period.resetAt) : null;
    const resetText = reset ? `（${reset} 重置）` : '';
    return `${label} ${String(pct).padStart(3)}% ${bar}${resetText}`;
  });
  return `套餐 ${parts.join('  ')}`;
}

/** CLI 人类可读报表 */
export function renderPlanReport(plan, { now = new Date() } = {}) {
  if (!plan?.ok) {
    return `Coding Plan 额度读取失败：${plan?.error ?? '未知错误'}\n`;
  }
  const lines = ['火山方舟 Coding Plan 额度快照', ''];
  const viewer = plan.viewer ?? {};
  const identity = [
    viewer.user_name || viewer.user_id || viewer.auth_method || '-',
    viewer.profile ? `profile ${viewer.profile}` : null,
    viewer.region || null,
    viewer.project_name ? `project ${viewer.project_name}` : null,
    viewer.is_root ? '主账号' : null,
  ]
    .filter(Boolean)
    .join('  ');
  lines.push(`  身份    ${identity || '-'}`);
  if (plan.tier || plan.edition) {
    lines.push(
      `  档位    ${[plan.tier, plan.edition].filter(Boolean).join(' / ')}`,
    );
  }
  lines.push('');
  for (const period of plan.periods) {
    const label = periodLabel(period.label).padEnd(6);
    const pct =
      period.percent === null
        ? '  —'
        : `${String(Math.round(period.percent)).padStart(3)}%`;
    const bar = barText(period.percent, 16);
    const usage =
      period.used !== null && period.total
        ? `${period.used} / ${period.total}`
        : '';
    const reset = formatReset(period.resetAt);
    const resetText = reset
      ? `重置于 ${reset}（${untilReset(period.resetAt, now)} 后）`
      : '';
    lines.push(`  ${label} ${pct} ${bar}  ${usage}  ${resetText}`.trimEnd());
  }
  if (plan.updatedAt) {
    lines.push('');
    lines.push(
      `  后端更新于 ${new Date(plan.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    );
  }
  lines.push(
    `  查询时间 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` +
      (plan.cached ? '（缓存）' : ''),
  );
  return `${lines.join('\n')}\n`;
}

// ---------- 分车道（coding plan vs deepseek） ----------

export function routerConfigPath() {
  return (
    process.env.ARK_ROUTER_CONFIG ||
    join(homedir(), '.codex', 'router', 'config.json')
  );
}

/** 读本机 ark-codex-router 的路由规则；读不到时退回内置默认规则 */
export function laneRules() {
  const fallback = {
    defaultLane: 'plan',
    prefixRoutes: [{ prefix: 'dsapi-', lane: 'deepseek' }],
  };
  try {
    const config = JSON.parse(readFileSync(routerConfigPath(), 'utf8'));
    return {
      defaultLane: config.default_lane ?? fallback.defaultLane,
      prefixRoutes: Array.isArray(config.prefix_routes)
        ? config.prefix_routes.map((rule) => ({
            prefix: String(rule.prefix ?? ''),
            lane: String(rule.lane ?? ''),
          }))
        : fallback.prefixRoutes,
    };
  } catch {
    return fallback;
  }
}

/** 模型名 → 车道（与 ark_router.py 的 resolve_route 同规则） */
export function laneOfModel(model, rules = laneRules()) {
  const name = String(model ?? '');
  for (const rule of rules.prefixRoutes ?? []) {
    if (rule.prefix && name.startsWith(rule.prefix)) return rule.lane;
  }
  return rules.defaultLane ?? 'plan';
}
