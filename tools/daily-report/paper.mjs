// 抓一篇论文的「写文档素材」：标题/作者/完成单位/摘要/各章节要点/关键图表（含图注）
// 数据来源：arXiv API（元数据）+ arXiv HTML 版（章节、图表）
import { fetchAffiliation, parseAffiliations, parseAuthors } from './affil.mjs';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';

const decode = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#xa0;/g, ' ');

export const stripTags = (s) =>
  decode(String(s ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const TEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ',
  mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', psi: 'ψ', omega: 'ω',
  times: '×', approx: '≈', pm: '±', leq: '≤', geq: '≥', cdot: '·', sim: '~', to: '→',
  infty: '∞', ldots: '…', cdots: '…', '%': '%',
};

/** 公式（MathML）→ 取 LaTeX 注记再简化成可读文本；没有注记就丢掉 */
function mathToText(m) {
  const ann = m.match(/<annotation[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>/i);
  const raw = ann ? ann[1] : (m.match(/<mtext[^>]*>([\s\S]*?)<\/mtext>/i)?.[1] ?? '');
  const tex = stripTags(raw)
    .replace(/\\(bm|boldsymbol|mathbf|mathrm|mathsf|text|operatorname|mathnormal)\b/g, '')
    .replace(/\\([a-zA-Z]+)/g, (_, name) => TEX_SYMBOLS[name] ?? name)
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return tex ? ` ${tex} ` : ' ';
}

/** 去掉注释/脚本/样式/SVG，并把公式换成可读文本（表格里的数字常放在 MathML 里） */
function preclean(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<math\b[\s\S]*?<\/math>/gi, mathToText)
    .replace(/<img[^>]*alt="\\?\[([^\]]*)\\?\]"[^>]*>/g, ' [$1] ');
}

/** 从 HTML 里抽出带标题的章节（h2），给出每节开头的文字 */
export function parseSections(html, { snippetChars = 700 } = {}) {
  const s = preclean(html);
  const heads = [];
  const re = /<h2[^>]*class="[^"]*ltx_title_section[^"]*"[^>]*>([\s\S]*?)<\/h2>/g;
  for (const m of s.matchAll(re)) heads.push({ title: stripTags(m[1]), start: m.index, end: m.index + m[0].length });
  if (!heads.length) {
    const re3 = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g;
    for (const m of s.matchAll(re3)) heads.push({ title: stripTags(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return heads.map((h, i) => {
    const stop = i + 1 < heads.length ? heads[i + 1].start : Math.min(s.length, h.end + 20000);
    const body = stripTags(s.slice(h.end, stop));
    return { title: h.title.replace(/^\d+(\.\d+)*\s*/, ''), snippet: body.slice(0, snippetChars) };
  });
}

/**
 * 抽出关键图表：figure 的编号 + 图注 + 图片地址。
 * arXiv 的 HTML 有三种嵌图方式，都要认：`<img src>`、`<object data="*.svg">`（很多论文是 SVG）、
 * 以及 `<img src="*.svg">`。
 */
export function parseFigures(html, { id, max = 8, captionChars = 500 } = {}) {
  const s = preclean(html);
  // HTML 里的图片 src 是相对 https://arxiv.org/html/ 的，例如 "2609.35394v1/overview.png"
  const base = id ? 'https://arxiv.org/html/' : null;
  const out = [];
  const re = /<figure([^>]*)>([\s\S]*?)<\/figure>/g;
  for (const m of s.matchAll(re)) {
    const attrs = m[1];
    const inner = m[2];
    const figId = attrs.match(/id="([^"]+)"/)?.[1] ?? '';
    if (/\.(sf|sub)\d+$/i.test(figId)) continue; // 子图跳过
    // 外层 figure 里可能嵌了多个子 figure，图注要挑「Figure N / Table N」那条（通常在最外层、排在最后）
    const caps = [...inner.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/g)].map((c) => stripTags(c[1]));
    const LABEL = /^(figure|fig\.?|table)\s*\d+/i;
    const caption = caps.find((c) => LABEL.test(c)) ?? caps[caps.length - 1] ?? '';
    if (!LABEL.test(caption)) continue; // 只有子图注，跳过
    const isTable = /ltx_table|ltx_role_table/i.test(attrs) || /^table\s*\d+/i.test(caption);
    const srcs = [
      ...[...inner.matchAll(/<img[^>]*src="([^"]+)"/g)].map((t) => t[1]),
      ...[...inner.matchAll(/<object[^>]*data="([^"]+)"/g)].map((t) => t[1]),
    ];
    const imgSrc = srcs.find(
      (src) => !src.startsWith('data:') && !/logo|icon|favicon/i.test(src) && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(src),
    );
    const label = caption.match(/^(figure|fig\.?|table)\s*([\d.]+)/i);
    out.push({
      kind: isTable ? 'table' : 'figure',
      fileId: figId,
      label: label ? `${label[1].toLowerCase().startsWith('fig') ? 'figure' : 'table'} ${label[2]}` : figId,
      caption: caption.slice(0, captionChars),
      imageUrl: imgSrc && base ? new URL(imgSrc, base).toString() : undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** 去掉单元格里的公式噪音（MathML 被抹掉后会留下 \mathrm 之类） */
const cleanCell = (s) =>
  stripTags(s)
    .replace(/\\([a-zA-Z]+)/g, (_, name) => TEX_SYMBOLS[name] ?? name)
    .replace(/[{}]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** 从 start 处的 <tag ...> 开始，按标签配对取出内部字符串（避免被嵌套的同名标签截断） */
function balancedInner(s, start, tag) {
  const scan = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  scan.lastIndex = start;
  let depth = 0;
  let end = -1;
  for (let t = scan.exec(s); t; t = scan.exec(s)) {
    if (t[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    } else depth += 1;
  }
  return end < 0 ? null : { inner: s.slice(start, end), end };
}

/** 取「本层」的 tr / td，跳过嵌套表格里的 */
function topLevelRows(inner) {
  const rows = [];
  const trRe = /<tr\b/g;
  let m;
  while ((m = trRe.exec(inner)) !== null) {
    const r = balancedInner(inner, m.index, 'tr');
    if (!r) break;
    trRe.lastIndex = r.end;
    const cells = [];
    const tdRe = /<t[dh]\b/g;
    let c;
    while ((c = tdRe.exec(r.inner)) !== null) {
      const cell = balancedInner(r.inner, c.index, r.inner.slice(c.index, c.index + 3).toLowerCase().startsWith('<th') ? 'th' : 'td');
      if (!cell) break;
      tdRe.lastIndex = cell.end;
      cells.push(cell.inner);
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 抽出表格内容（rows）。这才是「表格」该有的东西——
 * 之前只写了图注，文档里表就是空的（用户 2026-09-30 指出）。
 */
export function parseTables(html, { max = 8, maxRows = 14, maxCols = 7, cellChars = 22 } = {}) {
  const s = preclean(html);
  const out = [];
  const seen = new Set();

  /** 找这个表格块前面最近的「Table N」表注 */
  const findCaption = (idx) => {
    const before = s.slice(Math.max(0, idx - 5000), idx);
    const caps = [...before.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/g)].map((c) => stripTags(c[1]));
    return caps.reverse().find((c) => /^table\s*\d+/i.test(c)) ?? '';
  };

  const push = (caption, rows) => {
    rows = (rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
    if (!caption || !rows.length) return false;
    const label = caption.match(/^table\s*([\d.]+)/i);
    const key = label ? `table ${label[1]}` : caption.slice(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({
      label: key,
      caption: caption.slice(0, 300),
      rows: rows.slice(0, maxRows).map((r) => r.slice(0, maxCols)),
      rowCount: rows.length,
      truncated: rows.length > maxRows,
    });
    return true;
  };

  const tableRanges = [];
  // ① 先解析真正的 <table>（最可靠）；用标签配对切出完整一张表，避免被嵌套表截断
  const openRe = /<table\b/g;
  let om;
  while ((om = openRe.exec(s)) !== null) {
    if (out.length >= max) break;
    let depth = 0;
    let end = -1;
    const scan = /<table\b|<\/table>/g;
    scan.lastIndex = om.index;
    for (let t = scan.exec(s); t; t = scan.exec(s)) {
      if (t[0] === '</table>') {
        depth -= 1;
        if (depth === 0) {
          end = t.index;
          break;
        }
      } else depth += 1;
    }
    if (end < 0) continue;
    const inner = s.slice(om.index, end);
    tableRanges.push([om.index, end]);
    openRe.lastIndex = end;
    const caption = findCaption(om.index);
    if (!caption) continue;
    const rows = topLevelRows(inner)
      .map((cells) => cells.map((cell) => cleanCell(cell).slice(0, cellChars)))
      .filter((r) => r.some((c) => c))
      .slice(0, maxRows * 3);
    push(caption, rows);
  }

  // ② 有些论文的表不是 <table>，而是 <span class="ltx_tabular"> 套 ltx_tr / ltx_td。
  //    这时要取「表注后面第一张」外层表，内层同名前缀的 span 要跳过。
  const spanTabs = [...s.matchAll(/<span[^>]*class="[^"]*ltx_tabular[^"]*"[^>]*>/g)];
  for (const [i, b] of spanTabs.entries()) {
    if (out.length >= max) break;
    if (tableRanges.some(([a, b2]) => b.index >= a && b.index <= b2)) continue; // 在真表内部，跳过
    if (i > 0 && b.index - spanTabs[i - 1].index < 60000) continue; // 只取每张表的第一个（外层）
    const caption = findCaption(b.index);
    if (!caption) continue;
    const hardEnd = s.indexOf('</figure>', b.index);
    const seg = s.slice(b.index, hardEnd > 0 ? hardEnd : Math.min(s.length, b.index + 60000));
    const rows = [];
    for (const rs of seg.split(/<span[^>]*class="[^"]*ltx_tr[^"]*"[^>]*>/).slice(1)) {
      const cells = rs
        .split(/<span[^>]*class="[^"]*ltx_td[^"]*"[^>]*>/)
        .slice(1)
        .map((c) => cleanCell(c).slice(0, cellChars));
      if (cells.length) rows.push(cells);
      if (rows.length >= maxRows * 3) break;
    }
    push(caption, rows);
  }
  return out;
}

async function getText(url, { timeoutMs = 30000 } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** 抓一篇论文的完整素材 */
export async function fetchPaper(input, { figures = 6, snippetChars = 700 } = {}) {
  const bare = String(input).match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!bare) throw new Error(`无法识别的 arXiv id: ${input}`);
  const id = bare[1];

  // 1) 元数据 + 摘要（arXiv API）
  const apiXml = await getText(
    `https://export.arxiv.org/api/query?id_list=${id}&max_results=1`,
  );
  const entry = apiXml.split('<entry>')[1] ?? '';
  const pick = (re) => (entry.match(re) ?? [])[1];
  const meta = {
    id,
    version: (entry.match(/<id>[^<]*\/abs\/\d{4}\.\d{4,5}(v\d+)</) ?? [])[1] ?? '',
    title: stripTags(pick(/<title>([\s\S]*?)<\/title>/)),
    abstract: stripTags(pick(/<summary>([\s\S]*?)<\/summary>/)),
    published: pick(/<published>([^<]+)<\/published>/),
    updated: pick(/<updated>([^<]+)<\/updated>/),
    categories: [...new Set([...entry.matchAll(/term="([^"]+)"/g)].map((m) => m[1]))],
    authors: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => stripTags(m[1])),
    url: `https://arxiv.org/abs/${id}`,
    pdf: `https://arxiv.org/pdf/${id}`,
    html: `https://arxiv.org/html/${id}${(entry.match(/<id>[^<]*\/abs\/\d{4}\.\d{4,5}(v\d+)</) ?? [])[1] ?? ''}`,
  };

  // 2) HTML 版：章节 / 图表 / 机构（没有 HTML 版时降级为只有摘要）
  let html = null;
  try {
    html = await getText(meta.html);
  } catch {
    try {
      html = await getText(`https://arxiv.org/html/${id}v1`);
    } catch {
      html = null;
    }
  }
  if (!html) {
    return { ...meta, affiliations: [], sections: [], figures: [], tables: [], htmlAvailable: false };
  }

  const insts = parseAffiliations(html);
  const aff = insts.length ? insts : (await fetchAffiliation(id)).institutions;
  return {
    ...meta,
    affiliations: aff,
    authorsHtml: parseAuthors(html),
    sections: parseSections(html, { snippetChars }),
    figures: parseFigures(html, { id: `${id}${meta.version}`, max: figures }),
    tables: parseTables(html, { max: figures }),
    htmlAvailable: true,
  };
}

/** 把素材渲染成给模型读的紧凑 Markdown（省 token） */
export function renderPaperMaterial(p) {
  const out = [`# ${p.title}`, `- arXiv：${p.url} ｜ 提交 ${p.published?.slice(0, 10)} ｜ ${(p.categories ?? []).join(',')}`];
  if (p.affiliations?.length) out.push(`- 完成单位：${p.affiliations.join(' / ')}`);
  if (p.authors?.length) out.push(`- 作者：${p.authors.slice(0, 10).join(', ')}${p.authors.length > 10 ? ' 等' : ''}`);
  out.push(`- 摘要：${p.abstract}`);
  if (!p.htmlAvailable) {
    out.push('\n（没有 HTML 版，拿不到章节与图表，只能依据摘要）');
    return out.join('\n');
  }
  out.push('\n## 章节要点（每节截取开头部分）');
  for (const s of p.sections) out.push(`\n### ${s.title}\n${s.snippet}`);
  if (p.figures?.length) {
    out.push('\n## 关键图表（图注原文）');
    for (const f of p.figures) out.push(`- [${f.label}] ${f.caption}${f.imageUrl ? `\n  图片：${f.imageUrl}` : ''}`);
  }
  if (p.tables?.length) {
    out.push('\n## 表格内容（可直接引用，写进文档时用同一张表）');
    for (const t of p.tables) {
      out.push(`\n### ${t.label}（共 ${t.rowCount} 行${t.truncated ? '，这里只截了前若干行' : ''}）`);
      out.push(t.rows.map((r) => `| ${r.join(' | ')} |`).join('\n'));
    }
  }
  return out.join('\n');
}
