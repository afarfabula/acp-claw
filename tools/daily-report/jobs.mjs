// 采集：成都技术实习岗位池（官方源 + 实习僧 + DeepSeek Search/Fetch 增量发现）
//
// 来源（按用户要求的顺序）：
//   1) 字节跳动  —— 官方校招站 jobs.bytedance.com：先 POST /api/v1/csrf/token 拿 CSRF 令牌，
//                   再带 x-csrf-token 头 POST /api/v1/search/job/posts（portal_type=2），
//                   按 recruit_type.name === '实习' 过滤（2026-10-13 打通）
//   2) 京东      —— 官方校招接口（campus.jd.com/api/wx/position/page），能直接拿到岗位 + JD 原文
//   3) 阿里巴巴  —— 官方校园招聘站 campus-talent.alibaba.com：GET 页面拿 SESSION+XSRF cookie，
//                   POST /searchCondition/listBatch 发现实习批次，带 x-xsrf-token 头
//                   POST /position/search?batchId=<实习批次>（2026-10-13 打通）
//   4) 腾讯      —— 官方接口（careers.tencent.com/tencentcareer/api/post/Query，attrId=3 即实习）
//   5) 聚合/其他 —— 实习僧「成都」的完整实习搜索结果，最多遍历配置允许的页数
//   （可选）百度  —— 官方 talent.baidu.com/httservice/getPostListNew（recruitType=INTERN）
//   6) 网页发现   —— DeepSeek Search 找候选，Fetch 抓成 Markdown，再由 flash 核验岗位字段
//
// 每个来源独立失败互不影响；解析不了新结构时只在 failures 里报错，不抛异常。
// 官方接口始终优先；网页发现只补长尾，并经过城市/实习/技术岗/置信度四道校验。
import vm from 'node:vm';
import { readState, writeState } from './state.mjs';
import {
  DEFAULT_FIT_PROFILE,
  decorateJobsWithFit,
  deriveRuleFacts,
  enrichJobsSemantically,
  mergeJobDuplicates,
} from './jobs-intelligence.mjs';
import { discoverJobs } from './jobs-discovery.mjs';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_CITY = '成都';

/** 聚合站发现词：只用于发现实习池，不再承担方向过滤 */
export const DEFAULT_DISCOVERY_KEYWORDS = [
  '实习', '人工智能', '算法', '机器学习', '深度学习', '计算机视觉', '自然语言处理',
  '大模型', '多模态', '开发', '后端', '前端', '测试', '运维', '数据',
  '产品', '运营', '设计', '金融', '市场',
];
export const DEFAULT_KEYWORDS = DEFAULT_DISCOVERY_KEYWORDS;

/** 方向判定：标题/JD 命中即打标（可同时命中多个） */
export const DEFAULT_DIRECTIONS = [
  {
    label: '大模型',
    emoji: '🧠',
    keywords: [
      '大模型', 'llm', '语言模型', '多模态', 'vlm', 'vla', '生成式', 'agent', '智能体',
      '强化学习', 'rlhf', '预训练', '后训练', 'sft', '微调', '推理能力', '世界模型',
      '视频生成', '文生视频', '对话模型', '基座模型', '语言大模型', '模型算法',
      '具身', 'grpo', 'dpo', 'opd', '蒸馏', '对齐', '视觉语言',
    ],
  },
  {
    label: 'AI Infra',
    emoji: '🛠',
    keywords: [
      'infra', '推理', '部署', '训练框架', '算子', 'cuda', 'kernel', '编译', 'kv cache',
      '显存', '量化感知', 'w4a4', 'w3a3', '低比特', '模型量化', '量化压缩', '量化推理',
      'serving', '吞吐', '延迟', '加速', '引擎', '分布式', '端侧',
      '推理优化', '训练优化', '存储', '调度', '并行', '高性能', '异构',
    ],
  },
  {
    label: '算法/机器学习',
    emoji: '🤖',
    keywords: [
      '算法', '机器学习', '深度学习', '计算机视觉', '自然语言处理', 'nlp', '数据挖掘',
      '推荐算法', '搜索算法', '语音识别', '图像识别', '目标检测', '分割', 'ocr',
    ],
  },
  {
    label: '软件开发',
    emoji: '💻',
    keywords: [
      '开发', '软件工程师', '后端', '前端', '全栈', '服务端', '客户端', '嵌入式',
      'java', 'python', 'c++', 'golang', 'rust', 'android', 'ios', 'web',
    ],
  },
  {
    label: '数据',
    emoji: '📊',
    keywords: ['数据分析', '数据开发', '大数据', '数据工程', '数据科学', '数仓', 'sql', 'bi'],
  },
  {
    label: '测试/运维',
    emoji: '🧪',
    keywords: ['测试', '运维', 'devops', 'sre', '云平台', '基础设施'],
  },
  {
    label: '产品/运营',
    emoji: '📦',
    keywords: ['产品经理', '产品运营', '运营', '市场营销', '增长', '用户研究', '内容'],
  },
];

/** 噪音词：只用于标记和排序降权，不再从实习池里删除 */
export const DEFAULT_NOISE = [
  '量化策略', '量化研究', '量化投资', '量化交易', '量化分析', '私募', '证券', '基金',
  '期货', '投研', '资产管理', '交易员', '行研', '销售', '运营', '市场', '人力',
  '招聘', '财务', '行政', '客服', '法务', '采购', '标注',
];

/** 非技术岗位：标题/部门命中即排除（只看标题和部门，避免 JD 里的泛化词误杀技术岗） */
export const DEFAULT_NON_TECH = [
  ...DEFAULT_NOISE,
  '产品经理', '产品运营', '产品助理', '产品实习', '产品专员', '产品策划', '产品岗',
  '编辑', '记者', '助教', '顾问', '猎头', '设计', '剪辑', '摄影', '策划',
  '新媒体', '文案', '翻译', '审计', '会计', '商务拓展', 'bd', '校园大使',
  '主播', '直播',
];

/** 技术方向标签；technicalOnly 开启时只保留这些 */
export const TECHNICAL_DIRECTIONS = new Set([
  '大模型', 'AI Infra', '算法/机器学习', '软件开发', '数据', '测试/运维',
]);

/** 公司归属：聚合站结果按公司名归类（顺序即公司优先级） */
export const DEFAULT_COMPANY_PATTERNS = [
  { key: 'bytedance', name: '字节跳动', re: /字节|抖音|bytedance|byte dance|tiktok/i },
  { key: 'jd', name: '京东', re: /京东|jd\.com|jd物流|京东科技/i },
  { key: 'alibaba', name: '阿里巴巴', re: /阿里|蚂蚁|ant ?group|钉钉|淘宝|天猫|菜鸟|阿里云|通义/i },
  { key: 'tencent', name: '腾讯', re: /腾讯|tencent|微信/i },
  { key: 'baidu', name: '百度', re: /百度|baidu|小度/i },
];

/** 默认采集的公司（key 与 DEFAULT_COMPANY_PATTERNS 对应；startup = 聚合站里去掉大厂的部分） */
export const DEFAULT_COMPANIES = [
  { key: 'bytedance', name: '字节跳动', enabled: true },
  { key: 'jd', name: '京东', enabled: true },
  { key: 'alibaba', name: '阿里巴巴', enabled: true },
  { key: 'tencent', name: '腾讯', enabled: true },
  { key: 'startup', name: '其他公司（实习僧）', enabled: true },
  { key: 'discovered', name: '网页发现（已核验）', enabled: true },
  { key: 'baidu', name: '百度', enabled: false },
];

// ------------------------------------------------------------------ 基础请求

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'user-agent': UA, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}${text ? ` :: ${text.slice(0, 200)}` : ''}`);
  return text;
}

const getText = (url, opts) => request(url, opts);

async function getJSON(url, opts) {
  const text = await request(url, { ...opts, headers: { accept: 'application/json', ...(opts?.headers ?? {}) } });
  return JSON.parse(text);
}

// ------------------------------------------------------------------ 文本清洗

/** 聚合站标题里混了图标私用区字符与 HTML 实体，统一清洗 */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u200b-\u200f\ufeff\u2028\u2029]/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把 2026年09月11 / 2026/9/11 / 2026-09-11 统一成 YYYY-MM-DD */
export function normDate(s) {
  const t = cleanText(s);
  if (!t) return '';
  const m = t.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return t.slice(0, 10);
}

/**
 * 薪酬区间统一折算为日薪。
 * 支持 300-500/天、300元/天、4.5K-7.5K/月、1-1.5万/月、20-30元/小时。
 * 月薪按 21.75 个工作日、年薪按 12 个月、周薪按 5 天、时薪按 8 小时折算。
 */
export function parseDailySalary(value) {
  const text = cleanText(value).replace(/[￥¥]/g, ' ').replace(/[，,]/g, '');
  if (!text || !/\d/.test(text)) return null;
  // 避免把“实习 3 个月”“招聘 2 人”这类普通数字误判成薪酬。
  if (!/(?:元|[kK千万]|日薪|月薪|年薪|时薪|周薪|工资|薪酬|待遇|报酬|每(?:天|日|月|年|周|小时|时)|\/\s*(?:天|日|月|年|周|小时|时))/.test(text)) {
    return null;
  }
  const m = text.match(
    /(\d+(?:\.\d+)?)\s*([kK千万元]?)\s*(?:[-~—–至]\s*(\d+(?:\.\d+)?)\s*([kK千万元]?))?/,
  );
  if (!m) return null;
  const scale = (raw, unit) => {
    let n = Number(raw);
    if (/^[kK千]$/.test(unit)) n *= 1000;
    else if (/^[万wW]$/.test(unit)) n *= 10000;
    return n;
  };
  const rangeUnit = m[4] || m[2];
  let min = scale(m[1], m[2] || rangeUnit);
  let max = m[3] ? scale(m[3], m[4] || m[2]) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const period = /(?:年薪|每年|\/\s*年)/.test(text)
    ? 'year'
    : /(?:时薪|每小时|\/\s*(?:小时|时))/.test(text)
      ? 'hour'
      : /(?:周薪|每周|\/\s*周)/.test(text)
        ? 'week'
        : /(?:月薪|每月|月工资|\/\s*月)/.test(text) || /[kK千万]/.test(text) && !/(?:日薪|每天|每日|\/\s*(?:天|日))/.test(text)
          ? 'month'
          : 'day';
  if (period === 'year') {
    min /= 12 * 21.75;
    max /= 12 * 21.75;
  } else if (period === 'month') {
    min /= 21.75;
    max /= 21.75;
  } else if (period === 'week') {
    min /= 5;
    max /= 5;
  } else if (period === 'hour') {
    min *= 8;
    max *= 8;
  }
  return { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
}

/** 从 JD 正文里找明确的薪资写法，不把“实习 3 个月”这类时间要求误判成薪资 */
export function extractSalaryFromText(value) {
  const text = cleanText(value);
  if (!text) return '';
  const patterns = [
    /((?:日薪|时薪|月薪|年薪|实习工资|薪资|薪酬|待遇|报酬)[^。\n；;]{0,32}?\d+(?:\.\d+)?\s*(?:[kK千万])?\s*(?:[-~—–至]\s*\d+(?:\.\d+)?\s*(?:[kK千万])?)?\s*(?:元)?\s*(?:\/\s*(?:天|日|月|年|周|小时|时))?)/,
    /(\d+(?:\.\d+)?\s*(?:[kK千万])?\s*(?:[-~—–至]\s*\d+(?:\.\d+)?\s*(?:[kK千万])?)?\s*元?\s*\/\s*(?:天|日|月|年|周|小时|时))/,
    /(每(?:天|日|月|年|周|小时|时)\s*\d+(?:\.\d+)?\s*(?:[-~—–至]\s*\d+(?:\.\d+)?)?\s*(?:元|[kK千万])?)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && parseDailySalary(m[1])) return m[1];
  }
  return '';
}

/** 源站常见薪酬字段归一；不要把公司名、招聘人数等普通数字当薪资 */
export function sourceSalary(raw = {}) {
  const direct = [
    raw.salary, raw.salaryDesc, raw.salary_desc, raw.salaryDescription,
    raw.compensation, raw.payRange, raw.pay_range,
  ].find((v) => typeof v === 'string' && parseDailySalary(v));
  if (direct) return cleanText(direct);

  const min = raw.minSalary ?? raw.min_salary;
  const max = raw.maxSalary ?? raw.max_salary;
  if (min == null && max == null) return '';
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return '';
  // 字节等站点的 min/max 单位是 K/月，前端也是按“30-50K”展示。
  if ([lo, hi].filter(Number.isFinite).every((n) => n > 0 && n < 1000)) {
    return `${Number.isFinite(lo) ? lo : '?'}-${Number.isFinite(hi) ? hi : '?'}K/月`;
  }
  return `${Number.isFinite(lo) ? lo : '?'}-${Number.isFinite(hi) ? hi : '?'}元/月`;
}

const SALARY_BENCHMARKS = {
  bytedance: {
    default: [300, 500],
    '算法/机器学习': [300, 500],
    '软件开发': [300, 400],
    '数据': [300, 400],
    '测试/运维': [300, 400],
    evidence: '2026 年公开招聘样本：字节技术实习日薪约 300-500 元；成都缺岗未披露时取保守区间',
    url: 'https://www.baidu.com/s?wd=%E5%AD%97%E8%8A%82%E8%B7%B3%E5%8A%A8%20%E6%8A%80%E6%9C%AF%20%E5%AE%9E%E4%B9%A0%E7%94%9F%20%E6%97%A5%E8%96%AA',
  },
  tencent: {
    default: [300, 500],
    evidence: '2026 年公开大厂技术实习样本；腾讯官网未披露时取保守区间',
    url: 'https://careers.tencent.com/',
  },
  alibaba: {
    default: [300, 500],
    evidence: '2026 年公开大厂技术实习样本；阿里官网未披露时取保守区间',
    url: 'https://campus-talent.alibaba.com/campus/position',
  },
  jd: {
    default: [250, 400],
    evidence: '2026 年公开招聘样本；京东官网未披露时取保守区间',
    url: 'https://campus.jd.com/',
  },
  baidu: {
    default: [250, 400],
    evidence: '2026 年公开招聘样本；百度官网未披露时取保守区间',
    url: 'https://talent.baidu.com/',
  },
  startup: {
    default: [200, 400],
    evidence: '成都技术实习公开岗位样本；仅作参考，实际以面试沟通为准',
    url: 'https://www.shixiseng.com/interns?city=%E6%88%90%E9%83%BD',
  },
};

/**
 * 官网/JD/同岗位聚合都拿不到薪资时，给出岗位级参考区间。
 * 返回值始终带 source=benchmark 和证据说明，页面不能把它伪装成官网值。
 */
export function estimateInternshipSalary(item = {}) {
  const profile = SALARY_BENCHMARKS[item.companyKey] ?? SALARY_BENCHMARKS.startup;
  const tags = item.tags ?? [];
  const preferredTag = tags.find((tag) => Array.isArray(profile[tag]));
  const [min, max] = profile[preferredTag] ?? profile.default;
  return {
    salary: `¥${min}-${max}/天`,
    salarySource: 'benchmark',
    salaryEvidence: profile.evidence,
    salaryEvidenceUrl: profile.url,
  };
}

const oneLine = (s, n = 220) => {
  const t = cleanText(s).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 保留段落的多行 JD；上限只用于防止异常页面把数据文件撑爆 */
const fullText = (s, n = 6000) => {
  const t = cleanText(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 把岗位详情 HTML 转成可读纯文本，保留段落和列表换行 */
function htmlToText(s, n = 6000) {
  const text = String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return fullText(
    text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n'),
    n,
  );
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ 方向 / 公司归类

export function classifyDirections(text, directions = DEFAULT_DIRECTIONS) {
  const hay = String(text ?? '').toLowerCase();
  const hit = [];
  for (const d of directions) {
    if ((d.keywords ?? []).some((k) => hay.includes(String(k).toLowerCase()))) hit.push(d.label);
  }
  return hit;
}

/** 每个方向命中的关键词个数（用来判断岗位更偏哪一边） */
export function scoreDirections(text, directions = DEFAULT_DIRECTIONS) {
  const hay = String(text ?? '').toLowerCase();
  const scores = {};
  for (const d of directions) {
    scores[d.label] = (d.keywords ?? []).filter((k) => hay.includes(String(k).toLowerCase())).length;
  }
  return scores;
}

function emojiOf(label, directions = DEFAULT_DIRECTIONS) {
  return directions.find((d) => d.label === label)?.emoji ?? '📌';
}

function classifyCompany(name, patterns = DEFAULT_COMPANY_PATTERNS) {
  for (const p of patterns) if (p.re.test(name ?? '')) return p;
  return null;
}

// ------------------------------------------------------------------ 实习僧（聚合站）

/** 实习僧是 Nuxt SSR：岗位数据在 window.__NUXT__ 里，用 vm 求值后递归找岗位数组 */
function shixisengData(html) {
  const m = String(html).match(/window\.__NUXT__=(.*?)<\/script>/s);
  if (!m) return { items: [], total: 0 };
  const src = m[1].trim().replace(/;+\s*$/, '');
  const ctx = { window: {} };
  try {
    vm.createContext(ctx);
    vm.runInContext(`window.__NUXT__=${src}`, ctx, { timeout: 5000 });
  } catch {
    return { items: [], total: 0 };
  }
  const found = [];
  let total = 0;
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && node[0].uuid && node[0].cname) {
        found.push(...node);
        return;
      }
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (
      Array.isArray(node.data) &&
      node.data.length &&
      node.data[0] &&
      typeof node.data[0] === 'object' &&
      node.data[0].uuid &&
      node.data[0].cname
    ) {
      found.push(...node.data);
      const n = Number(node.total);
      if (Number.isFinite(n) && n > total) total = n;
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(ctx.window.__NUXT__);
  return { items: found, total };
}

export function parseShixiseng(html) {
  return shixisengData(html).items;
}

export function parseShixisengPage(html) {
  return shixisengData(html);
}

/** 岗位详情页同时有干净的岗位名、公司和 JD；列表页标题里夹着字体反爬字符，必须用详情页覆盖 */
export function parseShixisengDetail(html) {
  const m = String(html).match(/window\.__NUXT__=(.*?)<\/script>/s);
  if (!m) return {};
  const ctx = { window: {} };
  try {
    vm.createContext(ctx);
    vm.runInContext(`window.__NUXT__=${m[1].trim().replace(/;+\s*$/, '')}`, ctx, { timeout: 5000 });
  } catch {
    return {};
  }
  const info = ctx.window.__NUXT__?.state?.internInfo;
  if (!info) return {};
  return {
    jd: htmlToText(info.info ?? info.job_requirements ?? ''),
    title: cleanText(info.iname),
    companyName: cleanText(info.cname),
    city: cleanText(info.city),
    department: cleanText(info.job),
    degree: cleanText(info.degree),
    salary: cleanText(info.salary_desc),
    address: cleanText(info.address),
    publishedAt: normDate(info.refresh),
    requirement: cleanText(info.job_requirements),
  };
}

function shixisengItem(it) {
  return {
    externalId: it.uuid,
    title: cleanText(it.name),
    companyName: cleanText(it.cname),
    city: cleanText(it.city),
    salary:
      it.minsalary || it.maxsalary
        ? `${it.minsalary ?? '?'}-${it.maxsalary ?? '?'} 元/天`
        : '',
    degree: cleanText(it.degree),
    tags: [...(it.c_tags ?? []), ...(it.i_tags ?? [])].map((x) => cleanText(String(x))).filter(Boolean),
    url: `https://www.shixiseng.com/intern/${it.uuid}`,
    source: '实习僧',
    type: '实习',
  };
}

async function fetchShixisengPage(keyword, city, page, { timeoutMs } = {}) {
  const url =
    `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(keyword)}` +
    `&city=${encodeURIComponent(city)}&page=${page}`;
  const html = await getText(url, { timeoutMs });
  const parsed = parseShixisengPage(html);
  return {
    items: parsed.items
      .map(shixisengItem)
      .filter((it) => !city || String(it.city).includes(city)),
    rawCount: parsed.items.length,
    total: parsed.total,
  };
}

async function fetchShixisengDetail(url, { timeoutMs } = {}) {
  const html = await getText(url, { timeoutMs });
  return parseShixisengDetail(html);
}

export async function fetchShixisengPool(keywords, city, {
  timeoutMs,
  gapMs = 600,
  maxPagesPerKeyword = 40,
  maxPool = 1000,
  fetchDetails = true,
  detailConcurrency = 8,
} = {}) {
  const byId = new Map();
  let detailFailures = 0;
  for (const keyword of keywords) {
    for (let page = 1; page <= maxPagesPerKeyword && byId.size < maxPool; page++) {
      const { items, total, rawCount } = await fetchShixisengPage(keyword, city, page, { timeoutMs });
      for (const it of items) byId.set(it.externalId, it);
      const pages = total > 0 ? Math.ceil(total / 20) : maxPagesPerKeyword;
      if (!rawCount || page >= pages) break;
      await sleep(gapMs);
    }
  }

  let items = [...byId.values()].slice(0, maxPool);
  if (fetchDetails && items.length) {
    items = await mapLimit(items, detailConcurrency, async (it) => {
      try {
        const detail = await fetchShixisengDetail(it.url, { timeoutMs });
        return {
          ...it,
          ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v)),
        };
      } catch {
        detailFailures++;
        return { ...it, detailError: true };
      }
    });
  }
  return { items, detailFailures };
}

// ------------------------------------------------------------------ 腾讯（官方）

async function fetchTencent(keywords, { city, timeoutMs, maxPerQuery = 100, maxItems = 1000 } = {}) {
  const out = [];
  const seen = new Set();
  for (const kw of keywords) {
    for (let pageIndex = 1; pageIndex <= 10 && out.length < maxItems; pageIndex++) {
      const url =
        'https://careers.tencent.com/tencentcareer/api/post/Query' +
        `?timestamp=${Date.now()}000&keyword=${encodeURIComponent(kw)}` +
        `&pageIndex=${pageIndex}&pageSize=${maxPerQuery}&language=zh-cn&area=cn&attrId=3`;
      const json = await getJSON(url, {
        timeoutMs,
        headers: { referer: 'https://careers.tencent.com/' },
      });
      const posts = json?.Data?.Posts ?? [];
      for (const p of posts) {
        if (!p.PostId || seen.has(String(p.PostId))) continue;
        seen.add(String(p.PostId));
        if (city && !String(p.LocationName ?? '').includes(city)) continue;
        out.push({
          externalId: p.PostId,
          title: cleanText(p.RecruitPostName),
          companyName: '腾讯',
          city: cleanText(p.LocationName),
          salary: sourceSalary(p),
          type: '实习',
          department: [cleanText(p.BGName), cleanText(p.CategoryName)].filter(Boolean).join(' · '),
          url: p.PostURL || `https://careers.tencent.com/jobdesc.html?postId=${p.PostId}`,
          jd: fullText(p.Responsibility),
          publishedAt: normDate(p.LastUpdateTime),
          source: '腾讯招聘官网',
          keyword: kw,
        });
      }
      if (posts.length < maxPerQuery) break;
      await sleep(400);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 京东（官方）

async function fetchJd({ city, timeoutMs, maxItems = 1000 } = {}) {
  const url = 'https://campus.jd.com/api/wx/position/recommendPage';
  const json = await getJSON(url, {
    method: 'POST',
    timeoutMs,
    headers: { 'content-type': 'application/json', referer: 'https://campus.jd.com/' },
    body: JSON.stringify({
      pageSize: 1000,
      pageIndex: 0,
      parameter: { planIdList: null, recommendChannelPositionVoList: [{ deptCode: '' }] },
    }),
  });
  const all = [];
  for (const group of json?.body ?? []) {
    for (const ch of group?.channelPositionVoList ?? []) all.push(ch);
  }
  const out = [];
  for (const p of all) {
    const dir = cleanText(p.jobDirection);
    // 只看实习（京东把实习岗位标在 jobDirection / planName 里，例如 TGT实习生）
    const isIntern = /实习/.test(dir) || /实习/.test(cleanText(p.planName));
    if (!isIntern) continue;
    // 城市在 requirementVoList[].workCity（如"重庆市-重庆市"、"山东省-济南市"），去重拼接
    const cities = [...new Set((p.requirementVoList ?? []).map((r) => cleanText(r.workCity)).filter(Boolean))];
    const cityStr = cities.map((c) => c.replace(/^.*?-/, '')).join('/');
    // 京东接口会返回全国岗位；必须在截断 maxItems 前按目标城市过滤，
    // 否则北京岗位会占满结果池，成都岗位永远轮不到。
    if (city && (!cityStr || !cityStr.includes(city))) continue;
    out.push({
      externalId: String(p.publishId),
      title: cleanText(p.positionName),
      companyName: '京东',
      city: cityStr,
      cityUnknown: !cityStr,
      salary: sourceSalary(p),
      type: '实习',
      department: dir,
      url: `https://campus.jd.com/#/details?id=${p.publishId}`,
      jd: fullText(p.workContent),
      requirement: fullText(p.qualification),
      publishedAt: p.publishTime ? new Date(p.publishTime).toISOString().slice(0, 10) : '',
      source: '京东校招官网',
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

// ------------------------------------------------------------------ 百度（官方，可选）

async function fetchBaidu({ keywords, city, timeoutMs } = {}) {
  const out = [];
  for (const kw of keywords) {
    const body = new URLSearchParams({
      recruitType: 'INTERN',
      pageSize: '100',
      curPage: '1',
      keyWord: kw,
      projectType: '',
    });
    const json = await getJSON('https://talent.baidu.com/httservice/getPostListNew', {
      method: 'POST',
      timeoutMs,
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://talent.baidu.com/' },
      body: body.toString(),
    });
    for (const p of json?.data?.list ?? []) {
      const place = cleanText(p.workPlace);
      if (city && place && !place.includes(city)) continue;
      out.push({
        externalId: p.postId,
        title: cleanText(p.name),
        companyName: '百度',
        city: place,
        salary: sourceSalary(p),
        type: '实习',
        department: [cleanText(p.bgShortName), cleanText(p.projectType)].filter(Boolean).join(' · '),
        url: `https://talent.baidu.com/jobs/detail/${p.postId}`,
        jd: fullText(p.workContent),
        requirement: fullText(p.serviceCondition),
        publishedAt: normDate(p.publishDate),
        source: '百度招聘官网',
        keyword: kw,
      });
    }
    await sleep(400);
  }
  return out;
}

// ------------------------------------------------------------------ 字节跳动（官方校招站，只取实习）
//
// 2026-10-13 实测：jobs.bytedance.com 的搜索 API 必须先 POST /api/v1/csrf/token 拿 CSRF
// 令牌（响应种 atsx-csrf-token cookie），再带 x-csrf-token 头 POST /api/v1/search/job/posts，
// 否则边缘网关直接 405。portal_type=2 是校招站；结果混着社招/校招/实习，按
// recruitment_id_list=["202","301"] 服务端只查实习（202=日常实习，301=另一种实习类型；
// 来自前端 P={1:"1",2:"201",3:"202,301"} 的 type 映射）。

async function bytedanceCsrf({ timeoutMs } = {}) {
  const res = await fetch('https://jobs.bytedance.com/api/v1/csrf/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'https://jobs.bytedance.com/campus/position', 'user-agent': UA },
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`csrf HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const json = await res.json();
  const token = json?.data?.token;
  if (!token) throw new Error('csrf 未返回 token');
  return { token, cookie };
}

export async function fetchBytedance(keywords, {
  timeoutMs,
  maxItems = 1000,
  locationCodeList = [],
  pageSize = 50,
} = {}) {
  const { token, cookie } = await bytedanceCsrf({ timeoutMs });
  const out = [];
  const seen = new Set();
  for (const kw of keywords) {
    let total = Infinity;
    for (let offset = 0; offset < total && out.length < maxItems; offset += pageSize) {
      const res = await fetch('https://jobs.bytedance.com/api/v1/search/job/posts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-csrf-token': token,
          cookie,
          referer: 'https://jobs.bytedance.com/campus/position',
          origin: 'https://jobs.bytedance.com',
          'user-agent': UA,
        },
        body: JSON.stringify({
          keyword: kw, limit: pageSize, offset,
          job_category_id_list: [], tag_id_list: [], location_code_list: locationCodeList,
          subject_id_list: [], recruitment_id_list: ['202', '301'], portal_type: 2, job_function_id_list: [],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const json = await res.json();
      const rows = json?.data?.job_post_list ?? [];
      total = Number(json?.data?.count ?? total);
      if (!rows.length) break;
      for (const p of rows) {
        const rt = p?.recruit_type;
        if (rt?.name !== '实习' && rt?.id !== '202') continue; // 只要实习
        if (!p.id || seen.has(String(p.id))) continue;
        seen.add(String(p.id));
        out.push({
          externalId: String(p.id),
          title: cleanText(p.title),
          companyName: '字节跳动',
          city: (p.city_list ?? []).map((c) => cleanText(c.name)).filter(Boolean).join('/'),
          salary: sourceSalary(p.job_post_info ?? p),
          type: '实习',
          department: cleanText(p.job_category?.name),
          url: `https://jobs.bytedance.com/campus/position/${p.id}/detail`,
          jd: fullText(p.description),
          requirement: fullText(p.requirement),
          publishedAt: p.publish_time ? new Date(Number(p.publish_time)).toISOString().slice(0, 10) : '',
          source: '字节跳动校招官网',
          keyword: kw,
        });
      }
      if (rows.length < pageSize || offset + rows.length >= total) break;
      await sleep(400);
    }
    await sleep(400);
  }
  return out;
}

// ------------------------------------------------------------------ 阿里巴巴（官方校园招聘站，只取实习批次）
//
// 2026-10-13 实测：实习岗位不在 talent.alibaba.com（社招站），而在校园招聘站
// campus-talent.alibaba.com。流程：GET 校园页拿 SESSION + XSRF-TOKEN cookie →
// POST /searchCondition/listBatch 发现当前「实习」批次（日常实习 / 研究型实习）→
// 带 x-xsrf-token 头 POST /position/search（batchId 指定实习批次）。

/** 实习批次 ID 的兜底（listBatch 失败时用；按 2026-10 现状：日常实习 / 研究型实习） */
const ALI_INTERNSHIP_BATCH_FALLBACK = [100000560002, 100000560001];

function alibabaCookieJar() {
  const map = new Map();
  return {
    add(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const kv = c.split(';')[0];
        const j = kv.indexOf('=');
        if (j > 0) map.set(kv.slice(0, j).trim(), kv.slice(j + 1).trim());
      }
    },
    header() { return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(k) { return map.get(k); },
  };
}

/** 手动跟随重定向，确保 302 上的 Set-Cookie 都进 jar */
async function alibabaBoot(jar, url, timeoutMs) {
  let u = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(u, {
      headers: { 'user-agent': UA, cookie: jar.header(), accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar.add(res);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let loc = res.headers.get('location');
      if (loc.startsWith('//')) loc = `https:${loc}`;
      else if (loc.startsWith('/')) loc = `https://campus-talent.alibaba.com${loc}`;
      else if (loc.startsWith('http://')) loc = `https://${loc.slice(7)}`;
      res.text().catch(() => {});
      u = loc;
      continue;
    }
    await res.text().catch(() => {});
    return;
  }
}

async function alibabaApi(jar, path, body, { timeoutMs } = {}) {
  const res = await fetch(`https://campus-talent.alibaba.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: jar.header(),
      'x-xsrf-token': jar.get('XSRF-TOKEN') ?? '',
      referer: 'https://campus-talent.alibaba.com/campus/position',
      origin: 'https://campus-talent.alibaba.com',
      'user-agent': UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  jar.add(res);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

export async function fetchAlibaba(keywords, { timeoutMs, maxItems = 25 } = {}) {
  const jar = alibabaCookieJar();
  await alibabaBoot(jar, 'https://campus-talent.alibaba.com/campus/position', timeoutMs);

  // 发现实习批次；失败则用兜底批次 ID
  let batchIds = ALI_INTERNSHIP_BATCH_FALLBACK;
  try {
    const json = await alibabaApi(jar, '/searchCondition/listBatch', { channel: 'campus', language: 'zh' }, { timeoutMs });
    const interns = json?.content?.internship ?? [];
    if (interns.length) batchIds = interns.map((b) => b.id);
  } catch { /* 静默回退到兜底批次 */ }

  const out = [];
  const seen = new Set();
  for (const batchId of batchIds) {
    for (const kw of keywords) {
      for (let currentPage = 1; currentPage <= 20 && out.length < maxItems; currentPage++) {
        const json = await alibabaApi(jar, '/position/search', {
          searchKey: kw, pageSize: 20, currentPage, language: 'zh', batchId,
        }, { timeoutMs });
        const rows = json?.content?.datas ?? [];
        if (!rows.length) break;
        for (const p of rows) {
          if (!p.id || seen.has(String(p.id))) continue;
          seen.add(String(p.id));
          const ts = p.publishTime || p.modifyTime;
          out.push({
            externalId: String(p.id),
            title: cleanText(p.name),
            companyName: '阿里巴巴',
            city: (p.workLocations ?? []).map((c) => cleanText(String(c))).filter(Boolean).join('/'),
            salary: sourceSalary(p),
            type: '实习',
            department: [cleanText(p.batchName), cleanText(p.department)].filter(Boolean).join(' · '),
            url: `https://campus-talent.alibaba.com/campus/position-detail?positionId=${p.id}`,
            jd: fullText(p.requirement),
            requirement: fullText(p.description),
            publishedAt: ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '',
            source: '阿里巴巴校招官网',
            keyword: kw,
          });
        }
        if (rows.length < 20) break;
        await sleep(400);
      }
      await sleep(400);
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 汇总

function finalize(raw, { city, directions, keywords, noise = DEFAULT_NOISE }) {
  const blob = `${raw.title ?? ''} ${raw.jd ?? ''} ${raw.requirement ?? ''} ${(raw.tags ?? []).join(' ')}`;
  const tags = classifyDirections(blob, directions);
  const tagScores = scoreDirections(blob, directions);
  const kwHit = keywords.some((k) =>
    blob.toLowerCase().includes(String(k).toLowerCase()),
  );
  // 噪音只做标记和排序降权；完整实习池里的岗位不能因为方向不匹配而被删除
  const isNoise = (noise ?? []).some((k) => String(raw.title ?? '').toLowerCase().includes(String(k).toLowerCase()));
  return {
    ...raw,
    tags,
    tagScores,
    emojis: tags.map((t) => emojiOf(t, directions)),
    keywordHit: kwHit,
    noise: isNoise,
  };
}

export async function collectJobs(cfg, failures = [], opts = {}) {
  const conf = cfg.jobs ?? {};
  const city = opts.city ?? conf.city ?? DEFAULT_CITY;
  const cityCode = conf.cityCodes?.[city] ?? (city === '成都' ? 'CT_22' : '');
  const keywords =
    opts.keywords ??
    (conf.discoveryKeywords?.length ? conf.discoveryKeywords : DEFAULT_DISCOVERY_KEYWORDS);
  const directions = conf.directions?.length ? conf.directions : DEFAULT_DIRECTIONS;
  const noise = conf.noise?.length ? conf.noise : DEFAULT_NOISE;
  const nonTech = conf.nonTechKeywords?.length ? conf.nonTechKeywords : DEFAULT_NON_TECH;
  const technicalOnly = conf.technicalOnly !== false;
  const minDailySalary = Number(conf.minDailySalary ?? 200);
  const allowUnknownSalary = conf.allowUnknownSalary !== false;
  const estimateUnknownSalary = conf.estimateUnknownSalary !== false;
  const patterns = conf.companyPatterns?.length ? conf.companyPatterns : DEFAULT_COMPANY_PATTERNS;
  const companies = (conf.companies?.length ? conf.companies : DEFAULT_COMPANIES).filter((c) => c.enabled !== false);
  const profile = { ...DEFAULT_FIT_PROFILE, ...(conf.fitProfile ?? {}) };
  const semanticConf = {
    enabled: true,
    model: 'deepseek-flash',
    batchSize: 6,
    maxJdChars: 1800,
    ...(conf.semantic ?? {}),
    ...(opts.semantic ?? {}),
  };
  const searchConf = {
    enabled: false,
    mode: 'shadow',
    ...(conf.search ?? {}),
    ...(opts.search ?? {}),
  };
  const timeoutMs = conf.timeoutMs ?? 25000;
  const gapMs = opts.gapMs ?? conf.gapMs ?? 350;
  const maxPool = opts.maxPool ?? conf.maxPool ?? 1000;
  const notes = [];
  const progress = typeof opts.log === 'function' ? opts.log : () => {};
  const byCompany = new Map();
  const add = (key, items) => {
    if (!items?.length) return;
    byCompany.set(key, [...(byCompany.get(key) ?? []), ...items]);
  };
  const state = readState();
  const jobsState = (state.jobs ??= {});

  // 1) 先抓成都的完整实习池：分页遍历搜索页，并在详情页补齐 JD
  let pool = [];
  const needPool = companies.some((c) => c.key === 'startup' || c.adapter === 'shixiseng');
  if (needPool && conf.shixiseng !== false) {
    try {
      const result = await fetchShixisengPool(keywords, city, {
        timeoutMs,
        gapMs,
        maxPagesPerKeyword: conf.maxPagesPerKeyword ?? 40,
        maxPool,
        fetchDetails: conf.fetchDetails !== false,
        detailConcurrency: conf.detailConcurrency ?? 8,
      });
      pool = result.items;
      notes.push(
        `实习僧「${city}」池：${pool.length} 条（分页遍历 ${keywords.join(' / ')}，已补 JD）` +
          (result.detailFailures ? `；${result.detailFailures} 条详情页获取失败` : ''),
      );
    } catch (err) {
      failures.push(`实习僧池: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 聚合池里的大厂岗位按公司归桶，其余统一进「其他公司」；这样京东成都岗位
    // 即使不在京东校招接口里，也不会因为公司名被 startup 过滤器丢掉。
    const enabled = new Set(companies.map((c) => c.key));
    for (const it of pool) {
      const matched = classifyCompany(it.companyName, patterns);
      const key = matched?.key && enabled.has(matched.key) ? matched.key : (enabled.has('startup') ? 'startup' : null);
      if (key) add(key, [it]);
    }
  }

  // 2) 官方接口只做「实习 + 成都」筛选，不再按方向关键词裁岗位
  for (const company of companies) {
    const key = company.key;
    try {
      if (key === 'fintech' || company.adapter === 'shixiseng') {
        continue;
      }
      if (key === 'startup') {
        continue;
      }
      if (key === 'discovered') {
        continue;
      }
      if (key === 'tencent') {
        add('tencent', await fetchTencent([''], { city, timeoutMs, maxItems: maxPool }));
        continue;
      }
      if (key === 'jd') {
        add('jd', await fetchJd({ city, timeoutMs, maxItems: maxPool }));
        continue;
      }
      if (key === 'baidu') {
        add('baidu', await fetchBaidu({ keywords: [''], city, timeoutMs }));
        continue;
      }
      if (key === 'bytedance') {
        try {
          const items = await fetchBytedance([''], {
            timeoutMs,
            maxItems: maxPool,
            locationCodeList: cityCode ? [cityCode] : [],
          });
          add('bytedance', items.filter((it) => !city || String(it.city).includes(city)));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`字节跳动官网接口不可用（${msg.slice(0, 60)}），保留实习僧聚合结果`);
        }
        continue;
      }
      if (key === 'alibaba') {
        try {
          const items = await fetchAlibaba([''], { timeoutMs, maxItems: maxPool });
          add('alibaba', items.filter((it) => !city || String(it.city).includes(city)));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`阿里官网接口不可用（${msg.slice(0, 60)}），保留实习僧聚合结果`);
        }
        continue;
      }
      failures.push(`未知公司配置: ${key}`);
    } catch (err) {
      failures.push(`${company.name ?? key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) DeepSeek Search/Fetch 做长尾发现。shadow 模式只记录候选，不混入正式岗位池。
  const knownUrls = [...byCompany.values()].flat().map((it) => it.url).filter(Boolean);
  let discovery = {
    items: [],
    stats: { enabled: false, queries: 0, searchResults: 0, uniqueUrls: 0, fetched: 0, verified: 0, rejected: 0 },
    rejected: [],
    failures: [],
    queries: [],
  };
  if (searchConf.enabled) {
    try {
      discovery = await discoverJobs(city, {
        config: searchConf,
        knownUrls,
        directions,
        onProgress: (message) => progress(`[jobs/search] ${message}`),
      });
      const { stats } = discovery;
      notes.push(
        `DeepSeek 搜索：${stats.queries} 组查询 / ${stats.searchResults} 条结果 / ` +
          `${stats.fetched} 页被抓取 / ${stats.verified} 个已核验候选` +
          `（${stats.mode === 'shadow' ? '影子模式，未合入' : '增量模式'}）`,
      );
      if (stats.mode !== 'shadow') {
        const enabled = new Set(companies.map((c) => c.key));
        for (const item of discovery.items) {
          const matched = classifyCompany(item.companyName, patterns);
          const key = matched?.key && enabled.has(matched.key)
            ? matched.key
            : (enabled.has('discovered') ? 'discovered' : (enabled.has('startup') ? 'startup' : null));
          if (key) add(key, [{ ...item, companyKey: key }]);
        }
      }
      for (const failure of discovery.failures.slice(0, 4)) notes.push(`DeepSeek 发现：${failure}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      discovery.failures.push(message);
      notes.push(`DeepSeek 搜索不可用：${message.slice(0, 180)}`);
    }
  }

  // 4) 归一岗位字段。这里先不裁技术岗，等语义抽取完成后再判定。
  const order = new Map(companies.map((c, i) => [c.key, i]));
  const bySourceId = new Map();
  for (const [key, list] of byCompany) {
    for (const raw of list) {
      const item = finalize(raw, { city, directions, keywords, noise });
      const extractedSalary = item.salary ? '' : extractSalaryFromText(`${item.jd ?? ''} ${item.requirement ?? ''}`);
      const effectiveSalary = item.salary || extractedSalary;
      const dailyPay = parseDailySalary(effectiveSalary);
      const id = `${key}:${item.externalId}`;
      if (bySourceId.has(id)) continue;
      const keptTags = item.tags.length ? item.tags : ['其他'];
      bySourceId.set(id, {
        id,
        companyKey: key,
        company: item.companyName || key,
        title: item.title,
        city: item.city || '',
        cityUnknown: Boolean(item.cityUnknown || !item.city),
        type: item.type ?? '',
        department: item.department ?? '',
        tags: keptTags,
        tagScores: item.tagScores,
        emojis: keptTags.map((tag) => emojiOf(tag, directions)),
        salary: effectiveSalary,
        salarySource: item.salary ? 'source' : (extractedSalary ? 'jd' : ''),
        salaryReported: cleanText(item.salary),
        salaryDailyMin: dailyPay?.min ?? null,
        salaryDailyMax: dailyPay?.max ?? null,
        degree: item.degree ?? '',
        publishedAt: item.publishedAt ?? '',
        url: item.url ?? '',
        jd: item.jd ?? '',
        requirement: item.requirement ?? '',
        source: item.source ?? '',
        publisher: item.publisher ?? '',
        keyword: item.keyword ?? '',
        noise: item.noise,
        role: item.role ?? '',
        skills: item.skills ?? [],
        months: item.months ?? null,
        daysPerWeek: item.daysPerWeek ?? null,
        deadline: item.deadline ?? '',
        verification: item.verification ?? (new Set(['实习僧']).has(item.source) ? 'aggregate' : 'official'),
        discovery: item.discovery ?? null,
        discoveryConfidence: item.discoveryConfidence ?? null,
      });
    }
  }

  // 5) URL + 同公司/城市标题模糊去重；官方源优先保留并回填聚合薪资。
  const deduped = mergeJobDuplicates([...bySourceId.values()]);
  if (deduped.duplicates) notes.push(`跨来源去重：合并 ${deduped.duplicates} 个重复岗位`);
  const semanticCandidates = technicalOnly
    ? deduped.items.filter((item) => {
      const facts = deriveRuleFacts(item, { directions, nonTechKeywords: nonTech });
      return (facts.tags ?? []).some((tag) => TECHNICAL_DIRECTIONS.has(tag));
    })
    : deduped.items;
  if (deduped.items.length > semanticCandidates.length) {
    notes.push(`语义预筛：${deduped.items.length - semanticCandidates.length} 个非技术候选未送入模型`);
  }

  // 6) 先规则分类，再用 flash 做字段抽取。缓存按岗位内容 hash，未变化岗位不重复调用。
  const semanticCache = (jobsState.semantic ??= {});
  const semantic = await enrichJobsSemantically(semanticCandidates, {
    cache: semanticCache,
    enabled: semanticConf.enabled !== false,
    model: semanticConf.model,
    apiKeyEnv: semanticConf.apiKeyEnv,
    maxJdChars: semanticConf.maxJdChars,
    batchSize: semanticConf.batchSize,
    directions,
    nonTechKeywords: nonTech,
    log: (message) => progress(`[jobs/semantic] ${message}`),
  });
  jobsState.semantic = semantic.cache;
  if (semantic.stats.llmAnalyzed > 0) {
    notes.push(
      `语义抽取：${semantic.stats.llmAnalyzed} 个新/变更岗位，` +
        `${semantic.stats.cacheHits} 个命中缓存，${semantic.stats.failures} 批失败后降级规则`,
    );
  }

  const salaryItems = semantic.items.map((it) => {
    const semanticSalary = it.salary || extractSalaryFromText(`${it.jd ?? ''} ${it.requirement ?? ''}`);
    const effectiveSalary = semanticSalary || '';
    const pay = parseDailySalary(effectiveSalary);
    if (pay) {
      return {
        ...it,
        salary: effectiveSalary,
        salarySource: it.salary ? (it.discovery ? 'web' : 'source') : (semanticSalary ? 'jd' : ''),
        salaryStatus: 'verified',
        salaryDailyMin: pay.min,
        salaryDailyMax: pay.max,
      };
    }
    if (estimateUnknownSalary) {
      const estimated = estimateInternshipSalary(it);
      const estimatedPay = parseDailySalary(estimated.salary);
      return {
        ...it,
        ...estimated,
        salaryStatus: 'estimated',
        salaryDailyMin: estimatedPay?.min ?? null,
        salaryDailyMax: estimatedPay?.max ?? null,
      };
    }
    return {
      ...it,
      salaryStatus: 'unknown',
      salaryDailyMin: null,
      salaryDailyMax: null,
    };
  });

  // 7) 技术岗硬过滤、薪资硬过滤，最后按与用户研究方向的贴合度排序。
  const items = decorateJobsWithFit(salaryItems.filter((it) => {
    if (technicalOnly) {
      const technicalTags = (it.tags ?? []).filter((tag) => TECHNICAL_DIRECTIONS.has(tag));
      if (!technicalTags.length || it.semantic?.isTechnical === false) return false;
    }
    if (!it.salaryDailyMin && !it.salaryDailyMax) return allowUnknownSalary;
    return minDailySalary <= 0 || it.salaryDailyMin >= minDailySalary;
  }), profile).sort(
    (a, b) =>
      b.fitScore - a.fitScore ||
      Number(Boolean(a.noise)) - Number(Boolean(b.noise)) ||
      String(b.publishedAt).localeCompare(String(a.publishedAt)) ||
      (order.get(a.companyKey) ?? 99) - (order.get(b.companyKey) ?? 99) ||
      a.title.localeCompare(b.title),
  );

  // 增量：只标「新增」，并在 state 里记已读（保留 seenKeepDays 天）
  const seenMap = (jobsState.seen ??= {});
  const today = new Date().toISOString().slice(0, 10);
  const newItems = opts.all ? items : items.filter((it) => !seenMap[it.id]);
  if (opts.markSeen !== false && !opts.all) {
    for (const it of items) seenMap[it.id] = today;
    const keepDays = conf.seenKeepDays ?? 90;
    const cutoff = Date.now() - keepDays * 86400_000;
    for (const [id, date] of Object.entries(seenMap)) {
      if (new Date(`${date}T00:00:00Z`).getTime() < cutoff) delete seenMap[id];
    }
    const semanticCutoff = Date.now() - (conf.semanticKeepDays ?? 45) * 86400_000;
    for (const [id, entry] of Object.entries(jobsState.semantic ?? {})) {
      if (new Date(entry?.analyzedAt ?? 0).getTime() < semanticCutoff) delete jobsState.semantic[id];
    }
    jobsState.discovery = {
      lastRun: new Date().toISOString(),
      ...discovery.stats,
      rejected: discovery.rejected?.slice(0, 10) ?? [],
      failures: discovery.failures?.slice(0, 5) ?? [],
    };
    jobsState.lastRun = new Date().toISOString();
    jobsState.lastRunDate = today;
    writeState(state);
  }

  const summary = {
    total: items.length,
    newCount: newItems.length,
    byCompany: companies.map((c) => ({
      key: c.key,
      name: c.name ?? c.key,
      count: items.filter((it) => it.companyKey === c.key).length,
      newCount: newItems.filter((it) => it.companyKey === c.key).length,
    })),
  };

  return {
    city,
    keywords,
    filters: {
      technicalOnly,
      minDailySalary,
      allowUnknownSalary,
      estimateUnknownSalary,
      semantic: semanticConf.enabled !== false,
      searchMode: searchConf.enabled ? searchConf.mode ?? 'shadow' : 'off',
    },
    directions,
    companies: summary.byCompany,
    items,
    newItems,
    summary,
    notes,
    failures,
    intelligence: {
      fitProfile: profile,
      semantic: semantic.stats,
      discovery: {
        ...discovery.stats,
        queries: discovery.queries,
        rejected: discovery.rejected?.slice(0, 20) ?? [],
        failures: discovery.failures?.slice(0, 20) ?? [],
        candidates: discovery.items.slice(0, 30).map((it) => ({
          company: it.companyName,
          title: it.title,
          city: it.city,
          url: it.url,
          confidence: it.discoveryConfidence,
          rerankScore: it.discovery?.rerankScore,
          publishedAt: it.publishedAt,
          deadline: it.deadline,
          salary: it.salary,
          months: it.months,
          daysPerWeek: it.daysPerWeek,
        })),
      },
    },
  };
}

// ------------------------------------------------------------------ 写入飞书文档（Story 栏目）

/** 默认的 Story 栏目映射：大模型 → Story 1 基座模型；AI Infra → Story 2 Ai infra */
export const DEFAULT_DOC_SECTIONS = [
  { tag: '大模型', label: 'Story 1 · 基座模型', afterText: '基座模型', index: 3 },
  { tag: 'AI Infra', label: 'Story 2 · Ai infra', afterText: 'Ai infra', index: 5 },
];

/**
 * 挑出「还没写进文档」的岗位，按栏目分组。
 * published 形如 { [itemId]: 'YYYY-MM-DD' }（写在 state.json 的 jobs.published）
 * 返回 [{ section, items }]，只保留有内容的栏目
 */
export function pickForPublish(items, published = {}, sections = DEFAULT_DOC_SECTIONS, { maxPerSection } = {}) {
  const pending = items
    .filter((it) => !published[it.id])
    .sort((a, b) => {
      // 依次比较：实习优先 → 有城市信息的优先 → 日期新的优先 → 标题
      const intern = (x) => (/实习/.test(x.type ?? '') ? 0 : 1);
      const cityRank = (x) => (x.cityUnknown ? 2 : /成都/.test(x.city ?? '') ? 0 : 1);
      return (
        intern(a) - intern(b) ||
        cityRank(a) - cityRank(b) ||
        String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')) ||
        String(a.title).localeCompare(String(b.title))
      );
    });
  const used = new Set();
  const groups = [];
  // 岗位同时命中两个方向时，按「命中关键词更多」的一边归类（并列则按 sections 顺序）
  const primaryTag = (it) => {
    let best = null;
    for (const s of sections) {
      const score = it.tagScores?.[s.tag] ?? ((it.tags ?? []).includes(s.tag) ? 1 : 0);
      if (!score) continue;
      if (!best || score > best.score) best = { tag: s.tag, score };
    }
    return best?.tag ?? null;
  };
  for (const section of sections) {
    let hit = pending.filter(
      (it) => !used.has(it.id) && primaryTag(it) === section.tag,
    );
    if (maxPerSection > 0) hit = hit.slice(0, maxPerSection);
    for (const it of hit) used.add(it.id);
    if (hit.length) groups.push({ section, items: hit });
  }
  let rest = pending.filter((it) => !used.has(it.id));
  if (maxPerSection > 0) rest = rest.slice(0, maxPerSection);
  if (rest.length) {
    const other = sections[sections.length - 1] ?? DEFAULT_DOC_SECTIONS[0];
    const existing = groups.find((g) => g.section === other);
    if (existing) existing.items.push(...rest);
    else groups.push({ section: other, items: rest });
  }
  if (maxPerSection > 0) {
    return groups
      .map((g) => ({ ...g, items: g.items.slice(0, maxPerSection) }))
      .filter((g) => g.items.length);
  }
  return groups;
}

/** 渲染一段「写进文档」的 Markdown（表格速览 + 每个岗位的 JD） */
export function renderJobsPublishMarkdown(items, { date, label } = {}) {
  const out = [];
  out.push(`### 🆕 ${date ?? ''} 新增岗位（${items.length}）`);
  out.push('');
  out.push('| 公司 | 岗位 | 城市 | 类型 | 更新 | 链接 |');
  out.push('|---|---|---|---|---|---|');
  for (const it of items) {
    const city = it.cityUnknown ? '未标注' : it.city || '—';
    out.push(
      `| ${it.company} | ${it.title} | ${city} | ${it.type || '—'} | ${it.publishedAt || '—'} | [详情](${it.url}) |`,
    );
  }
  for (const it of items) {
    const city = it.cityUnknown ? '城市未标注' : it.city || '城市未知';
    out.push('');
    out.push(`**${it.company} · ${it.title}**（${city} ｜ ${it.type || '类型未知'}）`);
    if (it.jd) out.push(`- JD：${it.jd}`);
    if (it.requirement) out.push(`- 要求：${it.requirement}`);
    if (it.source) out.push(`- 来源：${it.source}`);
  }
  return out.join('\n');
}
