// 飞书文档「批注（评论）」的读写 + 增量去重
// 用户需求（2026-09-30）：自动触发时只处理「还没处理过」的批注，默认在批注里回复，不写正文
import { tenantToken, userToken } from '../feishu-doc/auth.mjs';

const API = 'https://open.feishu.cn/open-apis';

/** 从链接或 id 里取出 文档 id */
export function resolveDocId(input) {
  const s = String(input ?? '');
  return (
    s.match(/(?:docx|docs|wiki|sheets)\/([A-Za-z0-9]+)/)?.[1] ??
    s.match(/^([A-Za-z0-9]{20,})$/)?.[1] ??
    null
  );
}

/** 写操作用应用身份（宝宝），失败再退回用户身份 */
async function writeToken() {
  try {
    const t = await tenantToken();
    if (t) return t;
  } catch {
    // 忽略，用用户身份
  }
  return userToken();
}

async function call(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  if (j.code !== 0) throw new Error(`${method} ${path} 失败: code=${j.code} ${j.msg}`);
  return j.data;
}

export const replyText = (reply) =>
  (reply?.content?.elements ?? []).map((e) => e.text_run?.text ?? '').join('');

const ts = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : '');

/** 列出文档的全部批注（含已解决），按时间正序 */
export async function listComments(docId, { token } = {}) {
  const tk = token ?? (await tenantToken());
  const items = [];
  let pageToken;
  for (let i = 0; i < 20; i += 1) {
    const query = new URLSearchParams({
      file_type: 'docx',
      user_id_type: 'open_id',
      page_size: '50',
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    const data = await call(tk, `/drive/v1/files/${docId}/comments?${query}`);
    items.push(...(data.items ?? []));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return items.map((c) => ({
    commentId: c.comment_id,
    quote: c.quote ?? '',
    isWhole: Boolean(c.is_whole),
    isSolved: Boolean(c.is_solved),
    createdAt: ts(c.create_time),
    updatedAt: ts(c.update_time),
    replies: (c.reply_list?.replies ?? [])
      .map((r) => ({
        replyId: r.reply_id,
        userId: r.user_id,
        createdAt: ts(r.create_time),
        text: replyText(r),
      }))
      // 飞书返回的回复顺序不保证，按时间正序排一下，读起来才是对话
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

/** 回复某条批注；返回 reply_id */
export async function postReply(docId, commentId, text, { token } = {}) {
  const tk = token ?? (await writeToken());
  const data = await call(
    tk,
    `/drive/v1/files/${docId}/comments/${commentId}/replies?file_type=docx&user_id_type=open_id`,
    {
      method: 'POST',
      body: { content: { elements: [{ type: 'text_run', text_run: { text } }] } },
    },
  );
  return data.reply_id;
}

/** 标记批注「已解决 / 未解决」 */
export async function setSolved(docId, commentId, solved = true, { token } = {}) {
  const tk = token ?? (await writeToken());
  await call(tk, `/drive/v1/files/${docId}/comments/${commentId}?file_type=docx`, {
    method: 'PATCH',
    body: { is_solved: Boolean(solved) },
  });
}

/**
 * 找出「还没处理过」的批注。
 *
 * 判定依据是本地记下的 reply_id 集合：飞书返回的回复里，机器人自己用应用身份发的
 * 回复也会带上和用户相同的 user_id（实测），所以不能靠作者区分，只能靠本地状态。
 *
 * 首次检查（seen 为空且没建过基线）→ 把当前所有回复记成「已读」，只建基线不处理，
 * 避免一上线就把历史批注全部重做一遍。
 */
export function pickPending(comments, seenReplies, { baseline = false } = {}) {
  const seen = new Set(seenReplies ?? []);
  const pending = [];
  const nowSeen = [];
  for (const c of comments) {
    const fresh = c.replies.filter((r) => !seen.has(r.replyId));
    if (baseline) {
      nowSeen.push(...c.replies.map((r) => r.replyId));
      continue;
    }
    if (fresh.length) pending.push({ ...c, freshReplies: fresh });
  }
  return { pending, newlySeen: nowSeen };
}

/** 把一段批注（含整串对话）渲染成给模型看的文本 */
export function renderComment(c) {
  const head = [
    `批注 ${c.commentId}`,
    c.isSolved ? '已解决' : '未解决',
    c.isWhole ? '全文批注' : `引用：「${c.quote}」`,
    `最后更新 ${c.updatedAt.replace('T', ' ').slice(0, 16)}`,
  ].join(' ｜ ');
  const lines = [head];
  for (const r of c.replies) {
    const tag = r.replyId && c.freshReplies?.some((f) => f.replyId === r.replyId) ? '🆕 ' : '';
    lines.push(`  ${tag}${r.text.replace(/\n/g, ' ')}`);
  }
  return lines.join('\n');
}
