/**
 * DeepSeek 官网账户余额（用于飞书回复末尾的一行「余额 ¥x」）。
 *
 * 数据来源：https://api.deepseek.com/user/balance（Bearer 官方 key）。
 * key 优先取本机路由网关 `~/.codex/router/config.json` 里 deepseek 车道的 key
 * （即真正在按量计费的那把），找不到再退回环境变量 DEEPSEEK_API_KEY。
 *
 * 查询带 TTL 缓存（默认 5 分钟）并落盘 `~/.cache/codex-cost/deepseek-balance.json`，
 * 查询失败时退回过期缓存并标 cached，全部失败就返回 ok:false（调用方静默降级）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { routerConfigPath } from './router-lane.js';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_TTL_MS = 300_000;

export interface DeepseekBalance {
  ok: boolean;
  error: string | null;
  available?: boolean;
  currency?: string | null;
  total?: string | null;
  toppedUp?: string | null;
  granted?: string | null;
  fetchedAt: string;
  cached?: boolean;
}

/** 本机实际在用的 DeepSeek 官方 key（router 配置优先，其次环境变量） */
export function deepseekApiKey(): string | null {
  try {
    const config = JSON.parse(readFileSync(routerConfigPath(), 'utf8')) as {
      lanes?: Record<string, { api_key?: string }>;
    };
    const key = config.lanes?.deepseek?.api_key;
    if (key) return key;
  } catch {
    // 读不到 router 配置就走环境变量
  }
  return process.env.DEEPSEEK_API_KEY ?? null;
}

export function balanceCacheFile(): string {
  const dir =
    process.env.CODEX_COST_CACHE || join(homedir(), '.cache', 'codex-cost');
  return join(dir, 'deepseek-balance.json');
}

function readCacheFile(maxAgeMs: number): DeepseekBalance | null {
  const file = balanceCacheFile();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as DeepseekBalance;
    if (!raw?.fetchedAt) return null;
    const age = Date.now() - new Date(raw.fetchedAt).getTime();
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(payload: DeepseekBalance): void {
  try {
    const file = balanceCacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 写缓存失败不影响主流程
  }
}

async function fetchBalance(timeoutMs: number): Promise<DeepseekBalance> {
  const key = deepseekApiKey();
  const fetchedAt = new Date().toISOString();
  if (process.env.CODEX_COST_NO_BALANCE === '1') {
    return {
      ok: false,
      error: '余额查询已禁用（CODEX_COST_NO_BALANCE）',
      fetchedAt,
    };
  }
  if (!key) {
    return { ok: false, error: '没有找到 DeepSeek API key', fetchedAt };
  }
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `余额接口返回 HTTP ${res.status}`,
        fetchedAt,
      };
    }
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        topped_up_balance?: string;
        granted_balance?: string;
      }>;
    };
    const infos = data.balance_infos ?? [];
    const info = infos.find((b) => b.currency === 'CNY') ?? infos[0];
    if (!info) {
      return { ok: false, error: '余额接口没有返回 balance_infos', fetchedAt };
    }
    return {
      ok: true,
      error: null,
      available: data.is_available,
      currency: info.currency ?? null,
      total: info.total_balance ?? null,
      toppedUp: info.topped_up_balance ?? null,
      granted: info.granted_balance ?? null,
      fetchedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /timeout|abort/i.test(message) ? '余额查询超时' : message,
      fetchedAt,
    };
  }
}

/** 带 TTL 缓存的读取入口；失败时退回过期缓存（标 cached） */
export async function loadDeepseekBalance({
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  ttlMs?: number;
  timeoutMs?: number;
} = {}): Promise<DeepseekBalance> {
  const cached = readCacheFile(ttlMs);
  if (cached) return { ...cached, cached: true };

  const fresh = await fetchBalance(timeoutMs);
  if (fresh.ok) {
    writeCache(fresh);
    return { ...fresh, cached: false };
  }
  const stale = readCacheFile(24 * 3600_000);
  if (stale?.ok) return { ...stale, cached: true };
  return fresh;
}

/** 一行简短的余额文案：💰 余额 ¥43.21 */
export function renderBalanceLine(balance: DeepseekBalance): string | null {
  if (!balance.ok || !balance.total) return null;
  const symbol = balance.currency === 'CNY' ? '¥' : (balance.currency ?? '');
  return `💰 余额 ${symbol}${balance.total}`;
}

/** 供测试用：金额处理（保留两位的字符串） */
export function normalizeBalanceAmount(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}
