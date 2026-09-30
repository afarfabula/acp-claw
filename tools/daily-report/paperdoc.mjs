// 每周 Paper Reading 文档：用代码固定格式（校验 + 渲染 + 发布）
//
// 为什么要有这个模块：文档格式不能靠模型"记得写"，必须由代码保证——
//   1) validateSpec：缺 arXiv 链接 / 动机 / 方案 / 效果 / 关键结论 / 图表解释 直接报错
//   2) renderWeeklyDoc：按固定骨架渲染 Markdown（栏目顺序、层级都写死在代码里）
//   3) publishMarkdownDoc：把 Markdown 导入成飞书文档（表格、图片都会保留）
import { tenantToken, userToken } from '../feishu-doc/auth.mjs';
import { buildDocx, downloadImages } from './docx.mjs';
import { imageSize } from './docx.mjs';

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
      // 表格必须有真内容；图片必须有图片地址——只写图注不算（2026-09-30 踩过的坑）
      const isTable = /^table/i.test(f?.label ?? '');
      if (isTable) {
        const rows = f?.rows ?? [];
        if (rows.length < 2) {
          errors.push(`${tag}: 「${f.label}」是表格但没抓到内容（rows 至少 2 行，先跑 paper <id> 抓表格）`);
        } else if (rows.every((r) => r.every((c) => !String(c ?? '').trim()))) {
          errors.push(`${tag}: 「${f.label}」表格内容全是空的`);
        }
      } else if (!f?.imageUrl && !(f?.rows ?? []).length) {
        errors.push(`${tag}: 「${f?.label ?? `第 ${j + 1} 个`}」是图但既没有图片地址也没有表格内容`);
      }
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
  // 速览表的「论文」列用短标题，否则列被撑得又高又窄
  const shortTitle = (p) => {
    if (p.short) return p.short;
    const t = String(p.title ?? '');
    if (t.length <= 46) return t;
    const cut = t.slice(0, 46);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > 20 ? cut.slice(0, sp) : cut).trim()}…`;
  };
  spec.papers.forEach((p, i) => {
    out.push(
      `| ${i + 1} | [${shortTitle(p)}](${p.url}) | ${p.tag ?? '—'} | ${p.heat ?? '—'} | ${p.org ?? '未取到'} | ${p.status ?? '待读'} |`,
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
      // 表格：把抓到的真实内容渲染成原生表格（只写图注＝空表，用户明确要求必须有内容）
      if (f.rows?.length) {
        const cols = Math.max(...f.rows.map((r) => r.length));
        out.push(`| ${f.rows[0].map((c) => c || ' ').join(' | ')} |`);
        out.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
        for (const r of f.rows.slice(1)) {
          const cells = Array.from({ length: cols }, (_, i) => r[i] ?? ' ');
          out.push(`| ${cells.join(' | ')} |`);
        }
        out.push('');
        if (f.truncated) out.push(`（原表更长，这里截取前 ${f.rows.length} 行）`);
        if (f.truncated) out.push('');
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

/** 取出 Markdown 里图片的地址（按出现顺序）——与导入后文档里图片块的顺序一致 */
export function imageUrlsInMarkdown(markdown) {
  return [...String(markdown ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((u) => /^https?:\/\//.test(u));
}

async function req(tk, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tk}`, ...headers },
    body,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 120)}`);
  }
}

/** 按文档顺序取出所有图片块的 id */
export async function listImageBlocks(tk, docToken) {
  const items = [];
  let pageToken;
  for (let i = 0; i < 20; i += 1) {
    const q = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) q.set('page_token', pageToken);
    const j = await req(tk, `/docx/v1/documents/${docToken}/blocks?${q}`);
    if (j.code !== 0) throw new Error(`读块失败: ${j.code} ${j.msg}`);
    items.push(...(j.data?.items ?? []));
    if (!j.data?.has_more) break;
    pageToken = j.data.page_token;
  }
  // 按块在文档里的相对顺序排一下（根块下的 children 顺序才是阅读顺序）
  const byId = new Map(items.map((b) => [b.block_id, b]));
  const page = items.find((b) => b.block_type === 1) ?? items[0];
  const order = [];
  const walk = (id) => {
    const b = byId.get(id);
    if (!b) return;
    order.push(b);
    for (const c of b.children ?? []) walk(c);
  };
  for (const c of page?.children ?? []) walk(c);
  const seen = new Set(order.map((b) => b.block_id));
  for (const b of items) if (!seen.has(b.block_id)) order.push(b);
  return order.filter((b) => b.block_type === 27);
}

/**
 * 把真图绑到文档里的图片块上。
 *
 * 飞书 Markdown 导入**不会下载外链图片**，只会插一张占位图（实测 12 张全是同一张 22.7KB PNG）。
 * 正确做法：先把图上传成 `docx_image` 素材（**parent_node 必须是图片块的 block_id**，
 * 填文档 id 会报 `1770013 relation mismatch`），再用 `replace_image` 把占位图换掉。
 */
export async function bindImages(docToken, urls, { token, onLog = () => {} } = {}) {
  const tk = token ?? (await getToken('user'));
  const blocks = await listImageBlocks(tk, docToken);
  const result = { slots: blocks.length, urls: urls.length, bound: 0, failed: [] };
  const n = Math.min(blocks.length, urls.length);
  if (blocks.length !== urls.length) {
    result.failed.push(`图片块数(${blocks.length})与 Markdown 图片数(${urls.length})不一致，按前 ${n} 张对齐`);
  }
  for (let i = 0; i < n; i += 1) {
    const url = urls[i];
    const blockId = blocks[i].block_id;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'acp-claw-daily-report/1.0' } });
      if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const form = new FormData();
      const ext = (url.match(/\.(png|jpe?g|gif|webp)(\?|$)/i)?.[1] ?? 'png').toLowerCase();
      form.append('file_name', `fig-${i + 1}.${ext}`);
      form.append('parent_type', 'docx_image');
      form.append('parent_node', blockId); // ← 关键：图片块 id
      form.append('size', String(buf.length));
      form.append('extra', JSON.stringify({ drive_route_token: docToken }));
      form.append('file', new Blob([buf]), `fig-${i + 1}.${ext}`);
      const up = await req(tk, '/drive/v1/medias/upload_all', { method: 'POST', body: form });
      if (up.code !== 0 || !up.data?.file_token) throw new Error(`上传失败 ${up.code} ${up.msg}`);
      const patch = await req(tk, `/docx/v1/documents/${docToken}/blocks/${blockId}?document_revision_id=-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ replace_image: { token: up.data.file_token } }),
      });
      if (patch.code !== 0) throw new Error(`replace_image ${patch.code} ${patch.msg}`);
      result.bound += 1;
      onLog(`  [${i + 1}/${n}] ${url.split('/').pop()} → ${Math.round(buf.length / 1024)}KB ✓`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push(`第 ${i + 1} 张（${url}）: ${msg}`);
      onLog(`  [${i + 1}/${n}] 失败: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return result;
}

/**
 * 把 Markdown 导入成飞书文档（纯文字场景）。
 *
 * ⚠️ 带图的文档**不要**走这条（`file_extension: 'md'`）：飞书不会下载外链图片，只插一张占位图，
 * 且图片块的显示框被钉死成 1460x220（6.64:1），换成真图后会被压扁。带图请用 `publishDocxDoc`。
 */
// 导入耗时较长，实测 20–60s，轮询窗口要留够
export async function publishMarkdownDoc(markdown, name, { token, pollMs = 2000, maxPolls = 45 } = {}) {
  const tk = token ?? (await getToken('user'));
  return importFile(tk, Buffer.from(markdown, 'utf-8'), `${name}.md`, 'md', name, { pollMs, maxPolls });
}

/**
 * 把 Markdown 先渲染成 .docx 再导入飞书（**带图的正确做法**）。
 * 图片按原始比例嵌入，表格变原生表格，链接可点。
 */
export async function publishDocxDoc(markdown, name, { token, pollMs = 2000, maxPolls = 45, onLog = () => {} } = {}) {
  const tk = token ?? (await getToken('user'));
  // 导入 docx 时文档标题取自文件名，正文里再放一个 H1 会重复，所以去掉首个 H1
  const body = String(markdown).replace(/^#\s+.*\n+/, '');
  onLog('下载图片（按原始尺寸嵌入 docx）…');
  const images = await downloadImages(body, { onLog });
  const buf = buildDocx(body, images);
  onLog(`生成 docx：${Math.round(buf.length / 1024)}KB（含 ${images.size} 张图）`);
  return importFile(tk, buf, `${name}.docx`, 'docx', name, { pollMs, maxPolls });
}

/** 上传素材 → 建导入任务 → 轮询结果（md / docx / html 共用） */
async function importFile(tk, buffer, fileName, ext, name, { pollMs, maxPolls }) {

  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'ccm_import_open');
  form.append('parent_node', '/');
  form.append('size', String(buffer.length));
  form.append('extra', JSON.stringify({ obj_type: 'docx', file_extension: ext }));
  form.append('file', new Blob([buffer]), fileName);
  const up = await (
    await fetch(`${API}/drive/v1/medias/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}` },
      body: form,
    })
  ).json();
  if (up.code !== 0 || !up.data?.file_token) throw new Error(`上传素材失败: ${up.msg}`);

  const task = await (
    await fetch(`${API}/drive/v1/import_tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        file_extension: ext,
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

/**
 * 发布后自检：把每个图片块**下载回来**，比较「图片块记录的宽高比」与「图片本身真实的宽高比」。
 *
 * 这是被坑出来的检查：飞书 Markdown 导入会插占位图并把显示框钉死成 6.64:1，
 * 换成真图后接口返回的一切正常（token 有值、下载字节也对），但**渲染出来是压扁的**，
 * 只看接口字段根本发现不了。比例对不上就说明排版坏了。
 */
export async function verifyImageAspect(docToken, { token, tolerance = 0.05 } = {}) {
  const tk = token ?? (await getToken('user'));
  const blocks = await listImageBlocks(tk, docToken);
  const bad = [];
  for (const b of blocks) {
    try {
      const res = await fetch(`${API}/drive/v1/medias/${b.image.token}/download`, {
        headers: { Authorization: `Bearer ${tk}` },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const { width, height } = imageSize(buf);
      const boxRatio = b.image.width / b.image.height;
      const realRatio = width / height;
      if (Math.abs(boxRatio - realRatio) / realRatio > tolerance) {
        bad.push(
          `${b.block_id}: 显示框 ${b.image.width}x${b.image.height}(${boxRatio.toFixed(2)}:1) ≠ 实际 ${width}x${height}(${realRatio.toFixed(2)}:1)`,
        );
      }
    } catch (err) {
      bad.push(`${b.block_id}: 校验失败 ${err instanceof Error ? err.message : err}`);
    }
  }
  return { total: blocks.length, bad };
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
