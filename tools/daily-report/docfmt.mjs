// 日报文档规范化：
//   把「每天由模型自由发挥」写进飞书文档的简报，统一成固定结构——
//   条目标题一律 `## YYYY-MM-DD HH:MM`（二级标题），章节固定为 7 个、固定顺序（三级标题），
//   并按时间倒序排列（最新在最上面）。历史文档可以一键重排（cli.mjs fixdoc）。

const TZ_OFFSET_MS = 8 * 3600 * 1000; // 日报固定用北京时间

export const SECTION_ORDER = [
  '☀️ 天气',
  '🏫 学校通知',
  '📰 AI 新闻',
  '💰 DeepSeek 余额',
  '📄 论文',
  '🛠 Infra 动态',
  '📌 项目进展',
];

export const SLOTS = ['07:00', '12:00', '18:00'];

const ALIASES = new Map(Object.entries({
  '天气': SECTION_ORDER[0],
  'weather': SECTION_ORDER[0],
  '学校通知': SECTION_ORDER[1],
  '校园通知': SECTION_ORDER[1],
  '学院通知': SECTION_ORDER[1],
  '通知': SECTION_ORDER[1],
  'news': SECTION_ORDER[2],
  'ai新闻': SECTION_ORDER[2],
  '新闻': SECTION_ORDER[2],
  '新闻速览': SECTION_ORDER[2],
  'balance': SECTION_ORDER[3],
  'deepseek余额': SECTION_ORDER[3],
  '余额': SECTION_ORDER[3],
  '花费': SECTION_ORDER[3],
  '成本': SECTION_ORDER[3],
  '论文': SECTION_ORDER[4],
  'papers': SECTION_ORDER[4],
  'arxiv': SECTION_ORDER[4],
  'hf热榜': SECTION_ORDER[4],
  'hf日榜': SECTION_ORDER[4],
  'infra': SECTION_ORDER[5],
  'infra动态': SECTION_ORDER[5],
  '推理框架': SECTION_ORDER[5],
  '推理infra': SECTION_ORDER[5],
  '项目进展': SECTION_ORDER[5 + 1],
  'projects': SECTION_ORDER[6],
  '项目': SECTION_ORDER[6],
}));

/** 章节标签里可以安全删掉的前缀（删掉后正文不会丢信息） */
const STRIP_SAFE = new Set([
  '天气', 'ai新闻', '新闻', 'deepseek余额', '余额', '论文', 'infra', 'infra动态', '项目进展', '学校通知', '校园通知',
]);

const EMOJI_RE = /^[^\p{L}\p{N}]{1,4}\s*/u;
const LEAD_EMOJI_RE = /^(\*\*)?[\p{Extended_Pictographic}\u2600-\u27BF\u2B00-\u2BFF]/u;
const HEADING_RE = /^(#{1,6})\s*(.*)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function coreLabel(label) {
  const raw = String(label).replace(/\*\*/g, '').trim();
  const core = raw
    .replace(EMOJI_RE, '')
    .replace(/[（(][^）)]*[)）]/g, '')
    .replace(/[·・:：\-—].*$/, '')
    .replace(/\s+/g, '')
    .trim();
  return { raw, core, canonical: ALIASES.get(core.toLowerCase()) ?? ALIASES.get(core) ?? null };
}

/**
 * 一行里「栏目名 + 正文」的拆法有很多种写法：
 *   `💰 DeepSeek 余额：…` / `**💰 DeepSeek 余额** ¥49.39…` / `📄 论文 arXiv 近 24h …` / `📄 论文`
 * 这里按「冒号优先 → 加粗段 → 前两个词」的顺序给出候选，交给调用方挑第一个认得出的栏目名。
 */
function splitCandidates(body) {
  const out = [];
  const push = (label, rest) => {
    const l = String(label ?? '').trim();
    if (l) out.push({ label: l, rest: String(rest ?? '').trim() });
  };
  const bold = body.match(/^\*\*([\s\S]+?)\*\*\s*([\s\S]*)$/);
  if (bold) {
    const inner = bold[1];
    const tail = bold[2].trim();
    const bi = inner.search(/[：:]/);
    if (bi > 0) push(inner.slice(0, bi), [inner.slice(bi + 1).trim(), tail].filter(Boolean).join(' '));
    push(inner, tail.replace(/^[：:·\-\s]+/, ''));
  }
  const ci = body.search(/[：:]/);
  if (ci > 0) push(body.slice(0, ci), body.slice(ci + 1));
  push(body, '');
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length > 1) push(words.slice(0, 2).join(' '), words.slice(2).join(' '));
  if (words.length > 2) push(words.slice(0, 3).join(' '), words.slice(3).join(' '));
  return out;
}

/** 把一行/一个块分类：新条目（日期标题）→ 新章节（已知 emoji 标签）→ 普通正文 */
export function classifyLine(text, isHeading) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'blank' };
  const body = isHeading ? raw.replace(HEADING_RE, '$2').trim() : raw;
  // 条目标题可能写成「每日简报 2026-09-29（18:00）」「2026-09-16（周三）」两种
  const dateBody = body.replace(/^每日简报\s*[·•:：\-]?\s*/, '').trim();
  const dm = dateBody.match(DATE_RE);
  // 只有 Markdown 标题才算条目起始；正文里的「每日简报 2026-09-20（18:00 更新）」
  // 是模型自己写的落款，交给 walk() 丢掉
  if (dm && isHeading) {
    const tm = dateBody.slice(dm[0].length).match(/(\d{1,2}):(\d{2})/);
    return {
      kind: 'date',
      date: `${dm[1]}-${dm[2]}-${dm[3]}`,
      time: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : '',
    };
  }
  // 正文行必须是「emoji + 栏目名」（如 `💰 DeepSeek 余额：…`）才算栏目标题；
  // 否则像 `推理 Infra：Grouped Value Attention …` 这种正文会被误当成栏目
  const emojiLed = isHeading || LEAD_EMOJI_RE.test(raw);
  if (emojiLed) {
    for (const cand of splitCandidates(body)) {
      const { core, canonical } = coreLabel(cand.label);
      if (!canonical) continue;
      if (cand.label.length > 44 || cand.label.includes('。')) continue;
      // 前缀能安全删就删（避免章节标题被正文重复一遍），否则整行留给正文
      let rest = STRIP_SAFE.has(core.toLowerCase()) ? cand.rest : raw;
      // 整行加粗时（`**🔥 HF 热榜：…**`）删掉配不成对的收尾 `**`
      if (rest.endsWith('**') && ((rest.match(/\*\*/g) ?? []).length % 2 === 1)) rest = rest.slice(0, -2);
      return { kind: 'section', key: canonical, rest };
    }
  }
  return { kind: 'body', text: raw };
}

function newEntry(date = null, time = '') {
  return { date, time, sections: new Map(), order: [], preamble: [] };
}

function pushSection(entry, key, line) {
  if (!entry.sections.has(key)) {
    entry.sections.set(key, []);
    entry.order.push(key);
  }
  if (line) entry.sections.get(key).push(line);
}

/** 条目正文里混进来的「每日简报 2026-09-20（18:00 更新）」这类自引用行，直接丢掉 */
const STRAY_RE = /^\s*(📅\s*)?\*{0,2}\s*每日简报\s*\d{4}-\d{2}-\d{2}.*$/;

function isNewEntryStart(entry, key) {
  if (!entry) return false;
  const order = entry.order ?? [];
  if (!order.length && !(entry.preamble?.length ?? 0)) return false;
  const last = order[order.length - 1];
  if (key === SECTION_ORDER[0]) return order.includes(key); // 又见「天气」= 新的一篇
  const li = SECTION_ORDER.indexOf(last);
  const ki = SECTION_ORDER.indexOf(key);
  return li >= 0 && ki >= 0 && ki < li; // 章节回退（📌 之后又出现 📰）也算新的一篇
}

/** 遍历「文本 + 是否标题」序列，切成条目 */
function walk(items) {
  const header = [];
  const entries = [];
  let cur = null;
  for (const it of items) {
    const c = classifyLine(it.text, it.isHeading);
    if (c.kind === 'blank') continue;
    if (c.kind === 'date') {
      cur = newEntry(c.date, c.time);
      entries.push(cur);
      continue;
    }
    if (c.kind === 'section') {
      if (!cur || isNewEntryStart(cur, c.key)) {
        cur = newEntry();
        entries.push(cur);
      }
      pushSection(cur, c.key, c.rest);
      continue;
    }
    if (!cur) header.push(c.text);
    else if (STRAY_RE.test(c.text)) continue;
    else if (!cur.order.length) cur.preamble.push(c.text);
    else pushSection(cur, cur.order[cur.order.length - 1], c.text);
  }
  return { header, entries };
}

/** 解析一份（可能是整篇文档的）Markdown */
export function parseEntries(markdown) {
  const items = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const m = line.match(HEADING_RE);
      return { text: line.trim(), isHeading: Boolean(m) };
    })
    .filter((it) => it.text);
  return walk(items);
}

/** 解析飞书 blocks（按文档顺序，含 type/text）→ 条目在根块里的区间 */
export function entrySpans(blocks) {
  const header = [];
  const entries = [];
  let cur = null;
  blocks.forEach((b, i) => {
    const c = classifyLine(b.text, b.type >= 3 && b.type <= 8);
    if (c.kind === 'blank') return;
    if (c.kind === 'date') {
      cur = { date: c.date, time: c.time, start: i, end: i + 1, order: [] };
      entries.push(cur);
      return;
    }
    if (c.kind === 'section') {
      if (!cur || isNewEntryStart(cur, c.key)) {
        cur = { date: null, time: '', start: i, end: i + 1, order: [] };
        entries.push(cur);
      }
      if (!cur.order) cur.order = [];
      if (!cur.order.includes(c.key)) cur.order.push(c.key);
      cur.end = i + 1;
      return;
    }
    if (!cur) header.push(b.block_id);
    else cur.end = i + 1;
  });
  return { headerBlocks: header, entries };
}

export function tsOf(entry) {
  if (!entry?.date) return null;
  return Date.parse(`${entry.date}T${entry.time || '00:00'}:00+08:00`);
}

function fmtTs(ms) {
  const iso = new Date(ms + TZ_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function nextSlotAfter(ms) {
  const { date } = fmtTs(ms);
  const day = Date.parse(`${date}T00:00:00+08:00`);
  for (const d of [0, 1, 2]) {
    for (const slot of SLOTS) {
      const cand = day + d * 86400_000 + Number(slot.slice(0, 2)) * 3600_000 + Number(slot.slice(3)) * 60_000;
      if (cand > ms + 60_000) return cand;
    }
  }
  return ms + 3600_000;
}

/** 给没有日期标题的旧条目补日期：夹在前后两条之间，按 07/12/18 槽位递增 */
export function inferMissingDates(entries) {
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].date) continue;
    let next = null;
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[j].date) { next = entries[j]; break; }
    }
    const base = entries[i - 1]?.date ? entries[i - 1] : next;
    if (!base?.date) continue;
    const prevTs = tsOf(entries[i - 1] ?? base);
    const nextTs = next ? tsOf(next) : null;
    let cand = nextSlotAfter(prevTs ?? tsOf(base));
    if (nextTs !== null && cand >= nextTs) cand = Math.max(prevTs + 60_000, nextTs - 60_000);
    const f = fmtTs(cand);
    entries[i].date = f.date;
    entries[i].time = f.time;
  }
  return entries;
}

/**
 * 合并「碎片条目」：老文档里偶发只写了两三个栏目的残篇（没有日期标题，
 * 且栏目都被上一条覆盖），按栏目并回上一条并去掉完全重复的行，避免出现幽灵条目。
 */
export function mergeFragments(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    const isFragment = !e.date && e.order.length <= 2 && prev
      && e.order.every((k) => prev.sections.has(k));
    if (!isFragment) {
      out.push(e);
      continue;
    }
    for (const key of e.order) {
      const dst = prev.sections.get(key);
      for (const line of e.sections.get(key) ?? []) {
        if (line && !dst.includes(line)) dst.push(line);
      }
    }
  }
  return out;
}

/**
 * 人工校正（一次性整理用）：按正文命中串改日期、丢重复条目。
 * fixes = { dates: [{ match: '正文片段', stamp: 'YYYY-MM-DD HH:MM' }], drop: ['正文片段'] }
 */
export function applyFixes(entries, fixes = {}) {
  const text = (e) => [...e.sections.values()].flat().join('\n');
  const dropPatterns = (fixes.drop ?? []).filter(Boolean);
  const kept = dropPatterns.length
    ? entries.filter((e) => !dropPatterns.some((p) => text(e).includes(p)))
    : entries;
  let patched = 0;
  for (const e of kept) {
    const hit = (fixes.dates ?? []).find((d) => d?.match && text(e).includes(d.match));
    if (!hit) continue;
    const [date, time] = String(hit.stamp).split(/\s+/);
    e.date = date;
    e.time = time ?? '';
    patched += 1;
  }
  return { entries: kept, dropped: entries.length - kept.length, patched };
}

const sortKey = (e) => tsOf(e) ?? 0;

export function renderEntry(entry) {
  const out = [`## ${entry.date ?? '未标注日期'}${entry.time ? ` ${entry.time}` : ''}`];
  for (const line of entry.preamble ?? []) out.push('', line);
  const keys = [...entry.order];
  for (const k of SECTION_ORDER) if (entry.sections.has(k) && !keys.includes(k)) keys.push(k);
  keys.sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const key of keys) {
    out.push('', `### ${key}`);
    for (const line of entry.sections.get(key) ?? []) if (line) out.push('', line);
  }
  return out.join('\n');
}

export const DOC_INTRO =
  '本文件由 acp-claw 的 daily-report 工具自动维护：每次推送按固定栏目追加一篇简报，'
  + '**按时间倒序排列（最新在最上面）**。栏目顺序：☀️ 天气 → 🏫 学校通知 → 📰 AI 新闻 → '
  + '💰 DeepSeek 余额 → 📄 论文 → 🛠 Infra 动态 → 📌 项目进展。';

/** 渲染整篇文档：固定简介 + 条目倒序 */
export function renderDoc(entries, { intro = DOC_INTRO } = {}) {
  const out = [intro];
  for (const e of [...entries].sort((a, b) => sortKey(b) - sortKey(a))) {
    out.push('', renderEntry(e));
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** 把一份「新简报」规范成单条 Markdown（用于 publish） */
export function normalizeEntryMarkdown(markdown, { date, time } = {}) {
  const { header, entries } = parseEntries(markdown);
  let entry = entries.length ? entries[entries.length - 1] : newEntry(date, time);
  if (!entries.length && header.length) entry.preamble = header;
  if (!entry.date) entry.date = date ?? null;
  if (!entry.time) entry.time = time ?? '';
  return renderEntry(entry);
}
