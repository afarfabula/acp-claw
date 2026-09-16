// 配置与路径：运行时数据（配置、缓存、日报产物）都放在仓库之外
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function homeDir() {
  return expandHome(process.env.DAILY_REPORT_HOME ?? '~/.acp-claw/daily-report');
}

export function configPath() {
  return process.env.DAILY_REPORT_CONFIG ?? join(homeDir(), 'config.json');
}

const DEFAULTS = {
  timezone: 'Asia/Shanghai',
  weather: { enabled: true, hours: 24 },
  balance: { enabled: true, label: 'DeepSeek' },
  papers: { hours: 24, maxPerTopic: 6, arxiv: [], hfDailyPapers: { enabled: true, base: 'https://hf-mirror.com', top: 8 } },
  infra: { hours: 48, releases: [], trending: { enabled: false } },
  projects: { hours: 48, github: { enabled: false }, local: [] },
  feishu: {},
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 读取运行时配置；不存在时用 example 配置兜底（并提示） */
export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) {
    const example = join(HERE, 'config.example.json');
    const cfg = deepMerge(DEFAULTS, JSON.parse(readFileSync(example, 'utf-8')));
    return { config: cfg, path: p, missing: true };
  }
  const cfg = deepMerge(DEFAULTS, JSON.parse(readFileSync(p, 'utf-8')));
  return { config: cfg, path: p, missing: false };
}

export function resolveDataDir(cfg) {
  const dir = expandHome(cfg.dataDir ?? join(homeDir(), 'data'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateFile() {
  const p = join(homeDir(), 'state.json');
  return p;
}

export function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf-8'));
  } catch {
    return {};
  }
}

export function writeState(state) {
  const dir = homeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** 本地日期（YYYY-MM-DD）与时间戳，按指定时区 */
export function localParts(date = new Date(), timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    year: parts.year,
    time: `${parts.hour}:${parts.minute}`,
    stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

export function formatInZone(date, timeZone, opts) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, ...opts }).format(date);
}
