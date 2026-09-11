#!/usr/bin/env node
/**
 * 用授权码换取用户身份令牌（方案 B：用户身份 OAuth）
 *
 * 用法：
 *   node login.mjs <授权码>
 *   node login.mjs --url          只打印授权链接
 */
import { loadApp, saveTokens, TOKEN_FILE } from './auth.mjs';

const API = 'https://open.feishu.cn/open-apis';
const REDIRECT = process.env.FEISHU_REDIRECT_URI ?? 'http://localhost:3000/callback';
const SCOPES = process.env.FEISHU_SCOPES
  ?? 'offline_access docx:document drive:drive wiki:wiki';

function authUrl(appId) {
  const p = new URLSearchParams({
    client_id: appId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPES,
    state: 'baby-lark',
  });
  return `${API}/authen/v1/authorize?${p.toString()}`;
}

async function main() {
  const app = loadApp();
  const arg = process.argv[2];

  if (!arg || arg === '--url') {
    console.log('授权链接（在浏览器打开，授权后从地址栏复制 code）：');
    console.log(authUrl(app.appId));
    console.log(`\n重定向地址需在开放平台「安全设置 → 重定向 URL」中登记：${REDIRECT}`);
    return;
  }

  const res = await fetch(`${API}/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: app.appId,
      client_secret: app.appSecret,
      code: arg.trim(),
      redirect_uri: REDIRECT,
    }),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.access_token) {
    throw new Error(`换取令牌失败: code=${j.code} ${j.error_description ?? j.msg ?? JSON.stringify(j)}`);
  }
  const saved = saveTokens(j);
  console.log('✅ 用户身份令牌已保存');
  console.log(`access_token 有效期至: ${new Date(saved.access_expire_at).toLocaleString('zh-CN')}`);
  console.log(`refresh_token 有效期至: ${new Date(saved.refresh_expire_at).toLocaleString('zh-CN')}`);
  console.log(`授权范围: ${saved.scope ?? SCOPES}`);
  console.log(`令牌文件: ${TOKEN_FILE}`);
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
