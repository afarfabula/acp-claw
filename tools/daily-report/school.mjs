// 采集：学校 / 学院通知（电子科技大学研究生院 + 信通学院 + 学生工作部）
// 关注点：面向 2026 级研究生 —— 放假通知、奖助学金、教学安排、培养学籍、学位答辩、就业竞赛
// 每个源独立失败互不影响；解析不了新结构时只在 failures 里报错，不抛异常
import { readState, writeState } from './state.mjs';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';

/** 默认采集源。parser 决定用哪个列表解析器：
 *  - vsb       学院/学校 CMS（Visual SiteBuilder）：li > a > div.p-date(span 年 + b 月日) + p 标题
 *  - gr        研究生院 CMS：div.title > a + div.time（2026年09月23日）
 *  - xgbSearch 学生工作部搜索页（服务端渲染）：li > a(明细) > span.time(strong 日 + span 年-月) + div.title p
 */
export const DEFAULT_SOURCES = [
  // 信通学院（学院教务处/研究生科/学生科）
  { site: '信通学院', label: '研究生科', url: 'https://www.sice.uestc.edu.cn/index/tzgg/yjsk.htm', parser: 'vsb' },
  { site: '信通学院', label: '教务科', url: 'https://www.sice.uestc.edu.cn/index/tzgg/jwk.htm', parser: 'vsb' },
  { site: '信通学院', label: '学生科', url: 'https://www.sice.uestc.edu.cn/index/tzgg/xsk.htm', parser: 'vsb' },
  // 研究生院（校级教务/培养/奖助/学位）
  { site: '研究生院', label: '重要公告', url: 'https://gr.uestc.edu.cn/tongzhi/118', parser: 'gr' },
  { site: '研究生院', label: '教学管理', url: 'https://gr.uestc.edu.cn/tongzhi/119', parser: 'gr' },
  { site: '研究生院', label: '学生管理', url: 'https://gr.uestc.edu.cn/tongzhi/122', parser: 'gr' },
  { site: '研究生院', label: '奖助学金', url: 'https://gr.uestc.edu.cn/xuesheng/91', parser: 'gr' },
  { site: '研究生院', label: '评奖评优', url: 'https://gr.uestc.edu.cn/sixiang/88', parser: 'gr' },
  { site: '研究生院', label: '学位管理', url: 'https://gr.uestc.edu.cn/tongzhi/129', parser: 'gr' },
  { site: '研究生院', label: '就业实践', url: 'https://gr.uestc.edu.cn/tongzhi/123', parser: 'gr' },
  // 学生工作部（奖助学金 / 资助 / 日常管理，走站内搜索页）
  { site: '学生工作部', label: '奖学金', url: 'https://xgb.uestc.edu.cn/search?k=奖学金', parser: 'xgbSearch', spa: true },
  { site: '学生工作部', label: '助学金', url: 'https://xgb.uestc.edu.cn/search?k=助学金', parser: 'xgbSearch', spa: true },
  { site: '学生工作部', label: '放假通知', url: 'https://xgb.uestc.edu.cn/search?k=放假', parser: 'xgbSearch', spa: true },
];

/** 默认分类标签：按顺序取第一个命中的作为主标签 */
export const DEFAULT_TAGS = [
  {
    label: '放假/节假日',
    emoji: '🏖',
    keywords: ['放假', '假期', '节假', '中秋', '国庆', '寒假', '暑假', '元旦', '清明', '劳动节', '校历', '调休', '安全须知'],
  },
  {
    label: '奖助学金/评优',
    emoji: '💰',
    keywords: ['奖学金', '助学金', '奖助', '评奖', '评优', '助学贷款', '困难认定', '三助', '助教', '助研', '资助', '补助', '学费补偿', '代偿', '国家奖学金', '学业奖学金'],
  },
  {
    label: '教学/课程/考试',
    emoji: '📚',
    keywords: ['选课', '课程', '考试', '补考', '重修', '成绩', '教学安排', '培养方案', '开课', '上课', '培养计划', '学分'],
  },
  {
    label: '培养/学籍/报到',
    emoji: '🧾',
    keywords: ['报到', '注册', '学籍', '入学', '新生', '中期考核', '开题', '导师', '分流', '请假', '休学', '复学', '毕业资格', '材料提交', '档案'],
  },
  {
    label: '学位/答辩/毕业',
    emoji: '🎓',
    keywords: ['学位', '答辩', '论文', '送审', '盲审', '毕业', '预答辩', '学位授予'],
  },
  {
    label: '就业/实习/竞赛',
    emoji: '💼',
    keywords: ['就业', '实习', '招聘', '竞赛', '大赛', '双选', '宣讲', '网签', '创新创业'],
  },
  {
    label: '讲座/活动',
    emoji: '🎤',
    keywords: ['讲座', '论坛', '报告会', '沙龙', '学术交流', '交流月', '活动', '报名', '文体'],
  },
];

/** 常规/低价值通知：仍然采集，但只统计条数、不占简报篇幅 */
export const DEFAULT_NOISE = {
  keywords: ['调停课', '调课', '停课', '补课', '监考', '考场', '借教室', '借用教室', '会议室', '教师培训', '职称', '基建', '停电', '维修'],
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"', '#38': '&' };

function decodeEntities(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** 去标签 → 纯文本 */
export function toPlainText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 各种日期写法 → YYYY-MM-DD（失败返回 null） */
export function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/(\d{4})[-/.](\d{1,2})/); // 只有年月（学工部搜索页）
  if (m) return `${m[1]}-${pad2(m[2])}-01`;
  return null;
}

/** 学院/学校 VSB CMS 列表：<li><a href><div class="p-date"><span>2026</span> <b>09-23</b></div><p>标题</p></a></li> */
export function parseVsbList(html = '', baseUrl = '') {
  const items = [];
  const blocks = String(html).matchAll(/<li[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi);
  for (const [, href, inner] of blocks) {
    const dateM = inner.match(/<span>\s*(\d{4})\s*<\/span>\s*<b>\s*(\d{1,2})[-/.](\d{1,2})\s*<\/b>/i);
    const titleM = inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!dateM || !titleM) continue;
    const title = toPlainText(titleM[1]);
    if (!title) continue;
    items.push({
      title,
      url: absUrl(href, baseUrl),
      date: `${dateM[1]}-${pad2(dateM[2])}-${pad2(dateM[3])}`,
    });
  }
  return items;
}

/** 研究生院 CMS 列表：<div class="title"><a href>标题</a></div><div class="time">2026年09月23日</div> */
export function parseGrList(html = '', baseUrl = '') {
  const items = [];
  const blocks = String(html).matchAll(
    /<div class="title">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>\s*<div class="time">([\s\S]*?)<\/div>/gi,
  );
  for (const [, href, titleHtml, timeHtml] of blocks) {
    const title = toPlainText(titleHtml);
    const date = normalizeDate(toPlainText(timeHtml));
    if (!title) continue;
    items.push({ title, url: absUrl(href, baseUrl), date });
  }
  return items;
}

/** 学生工作部搜索页：<li><a href="/article/detail/x"><span class="time"><strong>3</strong> <span>2026-7</span></span><div class="title"><p>标题</p> */
export function parseXgbSearch(html = '', baseUrl = '') {
  const items = [];
  const blocks = String(html).matchAll(
    /<li>\s*<a href="([^"]+)">\s*<span class="time">\s*<strong>(\d{1,2})<\/strong>\s*<span>(\d{4})-(\d{1,2})<\/span>[\s\S]*?<div class="title">\s*<p>([\s\S]*?)<\/p>/gi,
  );
  for (const [, href, day, year, month, titleHtml] of blocks) {
    const title = toPlainText(titleHtml);
    if (!title) continue;
    items.push({
      title,
      url: absUrl(href, baseUrl),
      date: `${year}-${pad2(month)}-${pad2(day)}`,
    });
  }
  return items;
}

const PARSERS = { vsb: parseVsbList, gr: parseGrList, xgbSearch: parseXgbSearch };

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return String(href);
  }
}

async function getText(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 正文提取：按常见容器逐个尝试，取第一个文本量够长的 */
const DETAIL_MARKS = [
  /<div[^>]+id="vsb_content"[^>]*>/i,
  /<div[^>]+class="[^"]*topic_detail[^"]*"[^>]*>/i,
  /<div[^>]+class="[^"]*content[^"]*"[^>]*>/i,
  /<article[^>]*>/i,
];

/** 正文里常见的页脚/导航残留，遇到就截断 */
const DETAIL_CUTS = ['上一篇', '下一篇', '友情链接', '版权所有', '沙河校区：', '清水河校区：', '地址：', '上一条', '下一条'];

export function extractDetail(html = '', maxChars = 450) {
  const raw = String(html);
  let slice = '';
  for (const mark of DETAIL_MARKS) {
    const m = raw.match(mark);
    if (!m) continue;
    const start = (m.index ?? 0) + m[0].length;
    // 只截一段，避免把页脚/侧栏全带进来
    const chunk = raw.slice(start, start + 12000);
    let text = toPlainText(chunk).replace(/\n+/g, ' ').trim();
    if (text.length > 120) {
      for (const cut of DETAIL_CUTS) {
        const i = text.indexOf(cut);
        if (i > 100) text = text.slice(0, i).trim();
      }
      // 去掉开头的「标题 发布于：… 作者：… 浏览次数：…」重复信息
      const meta = text.match(/发布于：[\s\S]{0,160}?浏览次数：\s*\d+/u);
      if (meta && (meta.index ?? 999) < 160) text = text.slice(meta.index + meta[0].length).trim();
      slice = text;
      break;
    }
  }
  if (!slice) return '';
  return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice;
}

/** 标题分类：返回命中的全部标签（保持配置顺序），未命中返回「其它」 */
export function classifyTitle(title, tags = DEFAULT_TAGS) {
  const hay = String(title);
  const hit = tags.filter((t) => (t.keywords ?? []).some((k) => hay.includes(k))).map((t) => t.label);
  return hit.length ? hit : ['其它'];
}

function isNoise(title, noise) {
  const hay = String(title);
  const kw = { ...DEFAULT_NOISE, ...(noise ?? {}) }.keywords ?? [];
  return kw.some((k) => hay.includes(k));
}

/** 相对窗口起点：date 是否在最近 days 天内（无日期视为在窗口内） */
function inWindow(dateISO, sinceMs) {
  if (!dateISO) return true;
  const ts = Date.parse(`${dateISO}T00:00:00+08:00`);
  return Number.isNaN(ts) ? true : ts >= sinceMs;
}

function normKey(url) {
  return String(url).replace(/[?#].*$/, '').replace(/\/$/, '');
}

/**
 * 采集学校/学院通知。
 * @param {object} cfg 完整运行时配置
 * @param {string[]} failures 收集失败信息
 * @param {{days?:number, markSeen?:boolean, fetchDetails?:boolean}} opts
 */
export async function collectSchool(cfg, failures = [], opts = {}) {
  const conf = cfg.school ?? {};
  const sources = (conf.sources?.length ? conf.sources : DEFAULT_SOURCES).filter((s) => s.enabled !== false);
  const tags = conf.tags?.length ? conf.tags : DEFAULT_TAGS;
  const windowDays = opts.days ?? conf.windowDays ?? 7;
  const maxPerSource = conf.maxPerSource ?? 30;
  const sinceMs = Date.now() - windowDays * 86400_000;

  const results = [];
  const all = [];
  await Promise.all(
    sources.map(async (src) => {
      const label = `${src.site ?? ''}·${src.label ?? src.url}`;
      const parse = PARSERS[src.parser ?? 'vsb'];
      if (!parse) {
        failures.push(`学校源 ${label}: 未知解析器 ${src.parser}`);
        results.push({ ...src, count: 0, error: `未知解析器 ${src.parser}` });
        return;
      }
      try {
        const html = await getText(src.url, conf.timeoutMs ?? 20000);
        const items = parse(html, src.url)
          .filter((it) => inWindow(it.date, sinceMs))
          .slice(0, maxPerSource)
          .map((it) => ({
            ...it,
            site: src.site ?? '',
            section: src.label ?? '',
            sourceUrl: src.url,
            spa: Boolean(src.spa),
            tags: classifyTitle(it.title, tags),
            noise: isNoise(it.title, conf.noise),
          }));
        results.push({ site: src.site, label: src.label, url: src.url, count: items.length });
        all.push(...items);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`学校源 ${label}: ${msg}`);
        results.push({ site: src.site, label: src.label, url: src.url, count: 0, error: msg });
      }
    }),
  );

  // 去重（同一链接只留一条，保留信息更全的）
  const byKey = new Map();
  for (const it of all) {
    const key = normKey(it.url);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, it);
    else if (!prev.date && it.date) byKey.set(key, it);
  }

  const seenState = (readState().school ?? {}).seen ?? {};
  const items = [...byKey.values()]
    .map((it) => ({ ...it, isNew: !seenState[normKey(it.url)] }))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  // 新条目 + 重点分类 → 抓正文摘要（学院/研究生院页面可抓；学工部是 SPA，跳过）
  const detailTags = conf.detailTags ?? ['放假/节假日', '奖助学金/评优', '教学/课程/考试', '培养/学籍/报到', '学位/答辩/毕业'];
  const wantDetail =
    (opts.fetchDetails ?? conf.fetchDetails?.enabled ?? true)
      ? items
          .filter(
            (it) =>
              it.isNew &&
              !it.noise &&
              !it.spa &&
              it.tags.some((t) => detailTags.includes(t)),
          )
          .slice(0, conf.fetchDetails?.max ?? 8)
      : [];
  await Promise.all(
    wantDetail.map(async (it) => {
      try {
        it.detail = extractDetail(await getText(it.url, conf.timeoutMs ?? 20000), conf.fetchDetails?.maxChars ?? 600);
      } catch (err) {
        it.detailError = err instanceof Error ? err.message : String(err);
      }
    }),
  );

  const newItems = items.filter((it) => it.isNew);
  const summary = {
    total: items.length,
    newCount: newItems.length,
    noise: items.filter((it) => it.noise).length,
    newNoise: newItems.filter((it) => it.noise).length,
    byTag: Object.fromEntries(
      tags
        .map((t) => [t.label, newItems.filter((it) => !it.noise && it.tags.includes(t.label)).length])
        .filter(([, n]) => n > 0),
    ),
  };

  if (opts.markSeen !== false) {
    const st = readState();
    const now = new Date();
    const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const seen = { ...((st.school ?? {}).seen ?? {}) };
    for (const it of items) seen[normKey(it.url)] = seen[normKey(it.url)] ?? today;
    // 清理过期记录（默认保留 90 天）
    const keepMs = (conf.seenKeepDays ?? 90) * 86400_000;
    for (const [k, v] of Object.entries(seen)) {
      const ts = Date.parse(`${v}T00:00:00+08:00`);
      if (!Number.isNaN(ts) && Date.now() - ts > keepMs) delete seen[k];
    }
    st.school = { ...(st.school ?? {}), seen, lastRun: new Date().toISOString(), lastRunDate: today };
    writeState(st);
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    sources: results,
    tags: tags.map((t) => ({ label: t.label, emoji: t.emoji ?? '' })),
    items,
    newItems,
    summary,
    failures,
  };
}
