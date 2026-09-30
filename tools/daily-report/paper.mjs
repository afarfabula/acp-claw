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

/** 去掉注释/脚本/样式/SVG，并抹掉公式（MathML 会变成一堆乱码） */
function preclean(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<math[\s\S]*?<\/math>/gi, ' ')
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

/** 抽出关键图表：figure 的编号 + 图注 + 图片地址（表格只留图注） */
export function parseFigures(html, { id, max = 6, captionChars = 500 } = {}) {
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
    const imgSrc = inner
      .match(/<img[^>]*src="([^"]+)"/g)
      ?.map((t) => t.match(/src="([^"]+)"/)[1])
      .find((src) => !src.startsWith('data:') && !/logo|icon/i.test(src));
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
    return { ...meta, affiliations: [], sections: [], figures: [], htmlAvailable: false };
  }

  const insts = parseAffiliations(html);
  const aff = insts.length ? insts : (await fetchAffiliation(id)).institutions;
  return {
    ...meta,
    affiliations: aff,
    authorsHtml: parseAuthors(html),
    sections: parseSections(html, { snippetChars }),
    figures: parseFigures(html, { id: `${id}${meta.version}`, max: figures }),
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
  return out.join('\n');
}
