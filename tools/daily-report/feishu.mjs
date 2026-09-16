// 飞书投递：写文档（用户身份，复用 feishu-doc CLI）+（可选）发群消息（应用身份）
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tenantToken } from '../feishu-doc/auth.mjs';

const FEISHU_API = 'https://open.feishu.cn/open-apis';
export const FEISHU_DOC_CLI = join(
  new URL('.', import.meta.url).pathname,
  '..',
  'feishu-doc',
  'cli.mjs',
);

function runDocCli(args) {
  return execFileSync(process.execPath, [FEISHU_DOC_CLI, ...args], {
    encoding: 'utf-8',
    timeout: 120000,
  }).trim();
}

export function docTitleFromPattern(pattern, parts) {
  return String(pattern ?? '每日简报 {yyyy}-{MM}')
    .replaceAll('{yyyy}', parts.year)
    .replaceAll('{MM}', parts.month.slice(5))
    .replaceAll('{date}', parts.date)
    .replaceAll('{month}', parts.month);
}

/** 确保本月文档存在：优先用 state 缓存，否则新建（飞书文档 id 稳定，不会重复建） */
export function ensureDoc(title, state) {
  state.docs ??= {};
  if (state.docs[title]?.url) return { ...state.docs[title], created: false };
  const raw = runDocCli(['create', '--title', title]);
  const info = JSON.parse(raw);
  state.docs[title] = { id: info.document_id, url: info.url, createdAt: new Date().toISOString() };
  return { ...state.docs[title], created: true };
}

export function appendDoc(docRef, markdown) {
  const file = join(tmpdir(), `daily-report-${Date.now()}.md`);
  writeFileSync(file, markdown, 'utf-8');
  const out = runDocCli(['append', docRef.url ?? docRef.id, '--md', `@${file}`]);
  return out;
}

/**
 * 应用身份发消息（备用通道；正常路径是定时任务直接把最终回复发到群里）
 * receiveIdType: 'chat_id'（群）或 'open_id'/'user_id'（单聊）
 */
export async function sendMessage(receiveId, markdown, receiveIdType = 'chat_id') {
  const token = await tenantToken();
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [{ tag: 'markdown', content: markdown }],
    },
  };
  const res = await fetch(
    `${FEISHU_API}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
    signal: AbortSignal.timeout(20000),
    },
  );
  const j = await res.json();
  if (j.code !== 0) throw new Error(`发消息失败: code=${j.code} ${j.msg}`);
  return j.data?.message_id;
}

export function sendChatMessage(chatId, markdown) {
  return sendMessage(chatId, markdown, 'chat_id');
}
