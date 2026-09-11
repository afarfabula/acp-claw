// 飞书令牌管理：应用身份（tenant）与用户身份（user，支持 refresh token）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://open.feishu.cn/open-apis';
const __dirname = dirname(fileURLToPath(import.meta.url));
// 令牌等运行时数据放在仓库之外（避免误提交到 git）
const DATA_DIR = process.env.FEISHU_DATA_DIR
  ?? join(homedir(), '.acp-claw', 'feishu-doc-data');
export const TOKEN_FILE = join(DATA_DIR, 'user-token.json');

const CONFIG_CANDIDATES = [
  process.env.FEISHU_CONFIG,
  join(homedir(), '.acp-claw', 'config.json'),
  '/home_ext/quyanyi/.acp-claw/config.json',
].filter(Boolean);

export function loadApp() {
  for (const p of CONFIG_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8'));
      if (cfg?.feishu?.appId && cfg?.feishu?.appSecret) return cfg.feishu;
    } catch {
      // 忽略损坏配置
    }
  }
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET };
  }
  throw new Error('未找到飞书应用凭据');
}

let tenantCache = null;

export async function tenantToken() {
  if (tenantCache && tenantCache.expireAt > Date.now() + 60_000) return tenantCache.token;
  const app = loadApp();
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`获取 tenant token 失败: ${j.msg}`);
  tenantCache = { token: j.tenant_access_token, expireAt: Date.now() + j.expire * 1000 };
  return tenantCache.token;
}

function readTokenFile() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveTokens(payload) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const prev = readTokenFile() ?? {};
  const saved = {
    access_token: payload.access_token,
    // 飞书 v2 返回 expires_in（秒）
    access_expire_at: Date.now() + (payload.expires_in ?? 7200) * 1000,
    refresh_token: payload.refresh_token ?? prev.refresh_token,
    refresh_expire_at: Date.now() + (payload.refresh_token_expires_in ?? 30 * 86400) * 1000,
    scope: payload.scope ?? prev.scope,
    saved_at: new Date().toISOString(),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return saved;
}

export async function userToken() {
  const app = loadApp();
  const data = readTokenFile();
  if (!data?.access_token) throw new Error('尚未登录用户身份，先执行 login.mjs');
  if (data.access_expire_at > Date.now() + 60_000) return data.access_token;
  if (!data.refresh_token || data.refresh_expire_at < Date.now()) {
    throw new Error('用户令牌已过期且无法刷新，需要重新授权');
  }
  const res = await fetch(`${API}/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: app.appId,
      client_secret: app.appSecret,
      refresh_token: data.refresh_token,
    }),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.access_token) {
    throw new Error(`刷新用户令牌失败: code=${j.code} ${j.error_description ?? j.msg}`);
  }
  return saveTokens(j).access_token;
}

/** 默认：有用户令牌就用用户身份，否则用应用身份；可用 FEISHU_TOKEN_MODE 强制 */
export async function getAccessToken() {
  const mode = process.env.FEISHU_TOKEN_MODE ?? (existsSync(TOKEN_FILE) ? 'user' : 'tenant');
  return mode === 'user' ? userToken() : tenantToken();
}
