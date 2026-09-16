// 采集：AI 新闻（RSS/Atom 多源聚合，去重 + 时间窗过滤）
import { localParts } from './state.mjs';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';

const DEFAULT_FEEDS = [
  { label: '量子位', url: 'https://www.qbitai.com/feed', limit: 8 },
  {
    label: '雷峰网',
    url: 'https://www.leiphone.com/feed',
    limit: 8,
    keywords: ['AI', '大模型', '人工智能', '模型', '算力', '芯片', 'GPU', '机器人', '智能体'],
  },
  { label: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/', limit: 5 },
  { label: 'OpenAI News', url: 'https://openai.com/news/rss.xml', limit: 5 },
  { label: 'HuggingFace Blog', url: 'https://hf-mirror.com/blog/feed.xml', limit: 5 },
];

/** Hacker News（Algolia 官方 API，按标题命中 + 热度过滤，比 hnrss 稳定） */
const DEFAULT_HN = {
  enabled: true,
  minPoints: 60,
  hours: 36,
  limit: 10,
  queries: ['AI', 'LLM', 'OpenAI', 'GPU inference'],
};

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
  '#38': '&',
};

function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** 去掉 HTML 标签、脚本、多余空白，得到纯文本摘要（解码 → 去标签 → 再解码） */
function toPlainText(html = '') {
  const strip = (s) =>
    String(s)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h\d)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  return strip(decodeEntities(strip(decodeEntities(html))))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) {
      const text = toPlainText(m[1]);
      if (text) return text;
    }
  }
  return '';
}

function tagLink(block) {
  const attr = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (attr) return attr[1].trim();
  const text = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (text) {
    const url = toPlainText(text[1]);
    if (/^https?:\/\//i.test(url)) return url;
  }
  const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) {
    const url = toPlainText(guid[1]);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

function toDate(raw) {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  const m = raw.match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const ts2 = Date.parse(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`,
  );
  return Number.isNaN(ts2) ? null : new Date(ts2).toISOString();
}

/** 极简 RSS 2.0 / Atom 解析：只取 title / link / 时间 / 摘要 */
export function parseFeed(xml = '') {
  const isAtom = /<entry[\s>]/i.test(xml);
  const blocks = [
    ...String(xml).matchAll(
      isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi,
    ),
  ].map((m) => m[0]);

  const items = [];
  for (const block of blocks) {
    const title = tagText(block, ['title']);
    const link = tagLink(block);
    if (!title || !link) continue;
    const published = toDate(
      tagText(block, ['pubDate', 'published', 'updated', 'dc:date']),
    );
    const summary = tagText(block, [
      'description',
      'summary',
      'content:encoded',
      'content',
    ]);
    items.push({ title, link, published, summary });
  }
  return items;
}

async function getText(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJSON(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function matchKeywords(item, keywords) {
  if (!keywords?.length) return true;
  const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  return keywords.some((k) => hay.includes(String(k).toLowerCase()));
}

/** Hacker News：Algolia 搜索（标题命中 + 最少点赞），多关键词合并去重 */
async function collectHackerNews(conf, failures) {
  const hn = { ...DEFAULT_HN, ...(conf.hackerNews ?? {}) };
  if (hn.enabled === false) return { items: [], sources: [] };
  const since = Math.floor((Date.now() - (hn.hours ?? 36) * 3600_000) / 1000);
  const items = [];
  const sources = [];
  for (const q of hn.queries ?? DEFAULT_HN.queries) {
    try {
      const filters = `points>${hn.minPoints ?? 60},created_at_i>${since}`;
      const url =
        'https://hn.algolia.com/api/v1/search' +
        `?query=${encodeURIComponent(q)}&tags=story&restrictSearchableAttributes=title` +
        `&numericFilters=${encodeURIComponent(filters)}&hitsPerPage=${hn.limit ?? 10}`;
      const data = await getJSON(url, conf.timeoutMs ?? 20000);
      const hits = (data.hits ?? []).map((h) => ({
        source: 'Hacker News',
        title: h.title ?? '',
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        published: h.created_at ? new Date(h.created_at).toISOString() : null,
        summary: `${h.points} 分 / ${h.num_comments} 评论${h.story_text ? ` — ${toPlainText(h.story_text)}` : ''}`,
        points: h.points,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        id: h.objectID,
      }));
      items.push(...hits);
      sources.push({ label: `Hacker News「${q}」`, url, count: hits.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`Hacker News「${q}」: ${msg}`);
      sources.push({ label: `Hacker News「${q}」`, count: 0, error: msg });
    }
  }
  // 同一帖子可能被多个关键词命中
  const byId = new Map();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
  return { items: [...byId.values()], sources };
}

const normTitle = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 60);

/**
 * 聚合 AI 新闻。每个源独立失败，不影响其它源。
 * @returns {{generatedAt:string, windowHours:number, items:Array, sources:Array, failures:string[]}}
 */
export async function collectNews(cfg, failures = []) {
  const conf = cfg.news ?? {};
  const windowHours = conf.windowHours ?? 30;
  const feeds = conf.feeds?.length ? conf.feeds : DEFAULT_FEEDS;

  const sources = [];
  const all = [];
  await Promise.all(
    feeds.map(async (feed) => {
      const label = feed.label ?? feed.url;
      if (feed.enabled === false) return;
      const feedSince = Date.now() - (feed.windowHours ?? windowHours) * 3600_000;
      try {
        const items = parseFeed(await getText(feed.url, conf.timeoutMs ?? 20000))
          .map((it) => ({ ...it, source: label }))
          .filter((it) => !it.published || Date.parse(it.published) >= feedSince)
          .filter((it) => matchKeywords(it, feed.keywords))
          .slice(0, feed.limit ?? 8);
        sources.push({ label, url: feed.url, count: items.length });
        all.push(...items);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`新闻源 ${label}: ${msg}`);
        sources.push({ label, url: feed.url, count: 0, error: msg });
      }
    }),
  );

  const hn = await collectHackerNews(conf, failures);
  all.push(...hn.items);
  sources.push(...hn.sources);

  // 去重（同标题保留最早/最完整的一条）+ 按时间倒序（无时间排最后）
  const seen = new Map();
  for (const it of all) {
    const key = normTitle(it.title);
    const prev = seen.get(key);
    if (!prev || (it.published && prev.published && it.published > prev.published)) {
      seen.set(key, it);
    }
  }
  const items = [...seen.values()].sort((a, b) => {
    if (a.published && b.published) return b.published.localeCompare(a.published);
    if (a.published) return -1;
    if (b.published) return 1;
    return 0;
  });

  return {
    generatedAt: new Date().toISOString(),
    stamp: localParts(new Date(), cfg.timezone ?? 'Asia/Shanghai').stamp,
    windowHours,
    maxItems: conf.maxItems ?? 40,
    items: items.slice(0, conf.maxItems ?? 40),
    sources,
    failures,
  };
}

export { DEFAULT_FEEDS };
