// 「完成单位」采集：从 arXiv 的 HTML 版（LaTeX 源转换）里解析作者机构
// 数据来源优先级：arXiv HTML 的作者块 > OpenAlex 机构 > 未知
const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#xa0;|\s+/g, ' ')
    .trim();
}

export function arxivBareId(input) {
  return String(input ?? '').match(/(\d{4}\.\d{4,5})(v\d+)?/)?.[1] ?? null;
}

/** 从 html[idx] 处的 <span …> 开始，按标签嵌套取出这段 span 的纯文本 */
function spanTextAt(html, idx) {
  let i = html.indexOf('>', idx);
  if (i < 0) return '';
  i += 1;
  let depth = 1;
  let out = '';
  while (i < html.length && depth > 0) {
    if (html.startsWith('<span', i)) {
      depth += 1;
      i = html.indexOf('>', i);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (html.startsWith('</span', i)) {
      depth -= 1;
      i = html.indexOf('>', i);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (html[i] === '<') {
      // 其他标签（<br>、<a>、<math> 等）只跳过标签本身，保留其文字内容
      const close = html.indexOf('>', i);
      if (close < 0) break;
      out += ' ';
      i = close + 1;
      continue;
    }
    const next = html.indexOf('<', i);
    const end = next < 0 ? html.length : next;
    out += html.slice(i, end);
    i = end;
  }
  return out;
}

/** 机构名的清洗 + 噪音过滤 */
function cleanInstitution(raw) {
  const v = decode(raw)
    .replace(/^Affiliation\s*[:：]\s*/i, '')
    .replace(/^[\s,;:，；：/\-–—\[\](){}]+|[\s,;:，；：/\-–—\[\](){}]+$/g, '')
    .trim();
  if (v.length < 3) return ''; // 丢掉 "[" "1" "*" 这类解析噪音
  return v;
}

/** 去掉注释/脚本/样式/SVG，避免把字体版权声明之类的当机构 */
function preclean(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
}

/**
 * 兜底解析：有些论文的机构不放在 ltx_role_affiliation 里，
 * 而是跟在作者名后面或写成「1]Nanyang Technological University 2]Shanghai Jiao Tong University」这种。
 * 只在作者块附近 2500 字符内找「… University / Institute / Labs …」这类模式。
 */
export function parseAffiliationsLoose(html) {
  const s = preclean(html);
  const i = s.indexOf('ltx_authors');
  if (i < 0) return [];
  const region = s.slice(i, i + 2500).replace(/<[^>]+>/g, ' ');
  const re =
    /([A-Z][\w&.'’\-]*(?:\s+[A-Za-z0-9&.'’\-]+){0,4}?\s+(?:University|Universität|Institute|Academy|College|Laboratory|Laboratories|Labs|Inc\.|Corporation|Corp\.|Technologies|Technology|School))/g;
  const out = [];
  for (const m of region.matchAll(re)) {
    let v = decode(m[1]);
    // 处理 "ZhuoZhejiang University" 这种作者名和机构粘在一起的情况
    const sp = v.indexOf(' ');
    if (sp > 0) {
      const head = v.slice(0, sp);
      const cut = head.search(/[a-z][A-Z]/);
      if (cut >= 0) v = head.slice(cut + 1) + v.slice(sp);
    }
    v = cleanInstitution(v);
    if (v && v.length <= 80 && !/fonticons|creative commons|license/i.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 从 arXiv HTML 里抽出机构列表（去重、去掉 "Affiliation:" 前缀） */
export function parseAffiliations(html) {
  const s = preclean(html);
  const out = [];
  for (let i = s.indexOf('ltx_role_affiliation'); i >= 0; i = s.indexOf('ltx_role_affiliation', i + 1)) {
    const start = s.lastIndexOf('<span', i);
    if (start < 0) continue;
    const v = cleanInstitution(spanTextAt(s, start));
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length) return out;
  return parseAffiliationsLoose(s);
}

/** 从 arXiv HTML 里抽出作者名 */
export function parseAuthors(html) {
  const s = preclean(html);
  const out = [];
  for (let i = s.indexOf('ltx_personname'); i >= 0; i = s.indexOf('ltx_personname', i + 1)) {
    const start = s.lastIndexOf('<span', i);
    if (start < 0) continue;
    // 作者名只取到第一个 </span>（避免把紧跟的机构文字并进来）
    const open = s.indexOf('>', i);
    const close = s.indexOf('</span>', open);
    if (open < 0 || close < 0) continue;
    const v = decode(s.slice(open + 1, close));
    if (v && v.length <= 80 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 查一篇论文的「完成单位」。
 * 先试 v{version} 再试无版本号；arXiv 只对 2023-12 之后、用 LaTeX 投稿的论文生成 HTML。
 */
export async function fetchAffiliation(id, { timeoutMs = 25000 } = {}) {
  const bare = arxivBareId(id);
  if (!bare) throw new Error(`无法识别的 arXiv id: ${id}`);
  const errors = [];
  for (const path of [`${bare}v1`, bare]) {
    try {
      const res = await fetch(`https://arxiv.org/html/${path}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        errors.push(`${path}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const institutions = parseAffiliations(html);
      const authors = parseAuthors(html);
      if (institutions.length || authors.length) {
        return { id: bare, source: `https://arxiv.org/html/${path}`, authors, institutions };
      }
      errors.push(`${path}: 页面里没有作者块`);
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { id: bare, source: null, authors: [], institutions: [], note: errors.join(' | ') };
}

/** 批量查（顺序 + 间隔，避免把 arXiv 打限流） */
export async function fetchAffiliations(ids, { gapMs = 1200, max = 20 } = {}) {
  const out = new Map();
  let i = 0;
  for (const id of ids.slice(0, max)) {
    const rec = await fetchAffiliation(id);
    if (rec) out.set(arxivBareId(id), rec);
    i += 1;
    if (i < Math.min(ids.length, max)) await sleep(gapMs);
  }
  return out;
}
