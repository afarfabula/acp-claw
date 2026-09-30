// 每周 Paper Reading 文档：用代码固定格式（校验 + 渲染 + 发布）
//
// 为什么要有这个模块：文档格式不能靠模型"记得写"，必须由代码保证——
//   1) validateSpec：缺 arXiv 链接 / 动机 / 方案 / 效果 / 关键结论 / 图表解释 直接报错
//   2) renderWeeklyDoc：按固定骨架渲染 Markdown（栏目顺序、层级都写死在代码里）
//   3) publishMarkdownDoc：把 Markdown 导入成飞书文档（表格、图片都会保留）
import { tenantToken, userToken } from '../feishu-doc/auth.mjs';

const API = 'https://open.feishu.cn/open-apis';

/** 每篇论文必须有的字段（缺一个就报错，防止"内容太少"再次发生） */
export const REQUIRED_FIELDS = [
  ['url', 'arXiv 链接'],
  ['motivation', '动机'],
  ['method', '方案'],
  ['results', '效果'],
  ['conclusion', '关键结论'],
];

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//.test(u);

/** 校验：返回错误列表（空数组＝合格） */
export function validateSpec(spec) {
  const errors = [];
  if (!spec?.week) errors.push('缺少 week（如 2026-W40）');
  if (!Array.isArray(spec?.papers) || !spec.papers.length) errors.push('缺少 papers');
  for (const [i, p] of (spec?.papers ?? []).entries()) {
    const tag = p?.id ?? `#${i + 1}`;
    if (!p?.title) errors.push(`${tag}: 缺标题`);
    for (const [field, label] of REQUIRED_FIELDS) {
      if (!p?.[field]) errors.push(`${tag}: 缺「${label}」（${field}）`);
    }
    if (p?.url && !isHttp(p.url) && !/arxiv\.org\/abs\//.test(p.url)) {
      errors.push(`${tag}: url 不是可点击的 arXiv 链接（${p.url}）`);
    }
    if (p?.url && !/\/abs\/(\d{4}\.\d{4,5})/.test(p.url)) {
      errors.push(`${tag}: url 不是 arXiv /abs/ 链接，点进去看不到论文（${p.url}）`);
    }
    const figs = p?.figures ?? [];
    if (!figs.length) errors.push(`${tag}: 缺「关键图表」（figures 至少 1 条）`);
    for (const [j, f] of figs.entries()) {
      if (!f?.caption) errors.push(`${tag}: 第 ${j + 1} 个图表缺图注原文（caption）`);
      if (!f?.explain) errors.push(`${tag}: 第 ${j + 1} 个图表缺解读（explain）`);
    }
  }
  return errors;
}

const clean = (s) => String(s ?? '').replace(/\r/g, '').trim();

/** 渲染成 Markdown（飞书导入用）。栏目顺序与层级由本函数决定 */
export function renderWeeklyDoc(spec) {
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`格式不完整，先补齐再渲染：\n- ${errors.join('\n- ')}`);

  const out = [];
  out.push(`# Paper Reading ${spec.week}${spec.dateRange ? `（${spec.dateRange}）` : ''}`);
  out.push('');
  out.push('> **怎么用这篇文档**');
  out.push('>');
  out.push(`> - 每周 ${spec.papers.length} 篇，主题：${spec.theme ?? '视频/多模态 token 压缩 · 量化 · 后训练'}；每周一份，下周另开。`);
  out.push('> - 有疑问直接**选中文字写批注**（批注只针对你选中的内容）；daily update 触发时我会读新批注，');
  out.push('>   **在批注里回复**并标记「已解决」，不会重复回答已经处理过的批注。');
  out.push('> - 需要我把答案写进正文时，在批注里明确说一句「写进文档」即可。');
  out.push('');

  // 速览表
  out.push('## 本周速览');
  out.push('');
  out.push('| # | 论文 | 方向 | 热度 | 完成单位 | 状态 |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  spec.papers.forEach((p, i) => {
    out.push(
      `| ${i + 1} | [${p.title}](${p.url}) | ${p.tag ?? '—'} | ${p.heat ?? '—'} | ${p.org ?? '未取到'} | ${p.status ?? '待读'} |`,
    );
  });
  out.push('');

  spec.papers.forEach((p, i) => {
    out.push('---');
    out.push('');
    out.push(`## ${i + 1}. ${p.title}`);
    out.push('');
    const links = [`[arXiv 摘要页](${p.url})`];
    if (p.pdf) links.push(`[PDF](${p.pdf})`);
    if (p.html) links.push(`[HTML 全文](${p.html})`);
    if (p.code) links.push(`[代码](${p.code})`);
    out.push(links.join(' ｜ '));
    out.push('');
    out.push(`**完成单位**：${p.org ?? '未取到'}`);
    out.push('');
    if (p.authors?.length) {
      out.push(`**作者**：${p.authors.slice(0, 8).join(', ')}${p.authors.length > 8 ? ' 等' : ''}`);
      out.push('');
    }
    if (p.oneLiner) {
      out.push(`> **一句话**：${clean(p.oneLiner)}`);
      out.push('');
    }

    out.push('### 动机');
    out.push('');
    out.push(clean(p.motivation));
    out.push('');
    out.push('### 方案');
    out.push('');
    out.push(clean(p.method));
    out.push('');
    out.push('### 效果');
    out.push('');
    out.push(clean(p.results));
    out.push('');
    out.push('### 关键结论');
    out.push('');
    out.push(clean(p.conclusion));
    out.push('');

    out.push('### 关键图表');
    out.push('');
    for (const f of p.figures) {
      out.push(`**${f.label}**${f.title ? `：${f.title}` : ''}`);
      out.push('');
      if (f.imageUrl) {
        out.push(`![${f.label}](${f.imageUrl})`);
        out.push('');
      }
      out.push(`> 图注原文：${clean(f.caption)}`);
      out.push('>');
      out.push(`> 我的解读：${clean(f.explain)}`);
      out.push('');
    }

    if (p.takeaway) {
      out.push('### 对我的用处');
      out.push('');
      out.push(clean(p.takeaway));
      out.push('');
    }
    out.push('### 我的疑问 / 你的批注');
    out.push('');
    out.push(p.notes ?? '（在这里写批注提问，daily update 时会自动回复）');
    out.push('');
  });

  if (spec.appendix?.length) {
    out.push('---');
    out.push('');
    out.push('## 附录');
    out.push('');
    for (const a of spec.appendix) out.push(`- ${a}`);
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

async function getToken(prefer = 'user') {
  if (prefer === 'tenant') {
    try {
      return await tenantToken();
    } catch {
      // 退回用户身份
    }
  }
  return userToken();
}

/**
 * 把 Markdown 导入成飞书文档（表格 / 图片都会保留）。
 * 走的是飞书官方的「上传素材(ccm_import_open) → 建导入任务 → 轮询结果」流程。
 */
// 带图的 Markdown（十几张图）导入耗时较长，实测 20–60s，轮询窗口要留够
export async function publishMarkdownDoc(markdown, name, { token, pollMs = 2000, maxPolls = 45 } = {}) {
  const tk = token ?? (await getToken('user'));

  const form = new FormData();
  form.append('file_name', `${name}.md`);
  form.append('parent_type', 'ccm_import_open');
  form.append('parent_node', '/');
  form.append('size', String(Buffer.byteLength(markdown)));
  form.append('extra', JSON.stringify({ obj_type: 'docx', file_extension: 'md' }));
  form.append('file', new Blob([markdown], { type: 'text/markdown' }), `${name}.md`);
  const up = await (
    await fetch(`${API}/drive/v1/medias/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}` },
      body: form,
    })
  ).json();
  if (up.code !== 0 || !up.data?.file_token) throw new Error(`上传 Markdown 失败: ${up.msg}`);

  const task = await (
    await fetch(`${API}/drive/v1/import_tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_extension: 'md',
        file_name: name,
        file_token: up.data.file_token,
        type: 'docx',
        point: { mount_type: 1, mount_key: '' },
      }),
    })
  ).json();
  if (task.code !== 0 || !task.data?.ticket) throw new Error(`创建导入任务失败: ${task.msg}`);

  for (let i = 0; i < maxPolls; i += 1) {
    await new Promise((r) => setTimeout(r, pollMs));
    const j = await (
      await fetch(`${API}/drive/v1/import_tasks/${task.data.ticket}`, {
        headers: { Authorization: `Bearer ${tk}` },
      })
    ).json();
    const res = j.data?.result;
    if (res?.job_status === 0) {
      return { token: res.token, url: res.url ?? `https://feishu.cn/docx/${res.token}`, type: res.type };
    }
    if (res && res.job_status !== 1 && res.job_status !== 2) {
      throw new Error(`导入失败: job_status=${res.job_status} ${res.job_error_msg ?? ''}`);
    }
  }
  throw new Error('导入超时（任务一直没完成）');
}

/** 把文档分享给某人（默认给用户自己，保证能编辑/批注） */
export async function shareDoc(docToken, memberOpenId, { perm = 'full_access' } = {}) {
  const tk = await getToken('tenant');
  const res = await fetch(`${API}/drive/v1/permissions/${docToken}/members?type=docx&need_notification=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ member_type: 'open_id', member_id: memberOpenId, perm }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`分享失败: ${j.code} ${j.msg}`);
  return j.data;
}
