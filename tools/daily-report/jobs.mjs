// 采集：实习/招聘岗位（默认只看成都 base，只保留大模型 / AI Infra 方向）
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
//   5) 初创/其他 —— 实习僧「成都 + 方向关键词」的结果里，去掉大厂后的部分
//   （可选）百度  —— 官方 talent.baidu.com/httservice/getPostListNew（recruitType=INTERN）
//
// 每个来源独立失败互不影响；解析不了新结构时只在 failures 里报错，不抛异常。
// 官方接口失败时，字节/阿里自动回退到实习僧按公司名筛。
import vm from 'node:vm';
import { readState, writeState } from './state.mjs';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_CITY = '成都';

/** 默认搜索关键词（用于官方接口检索与聚合站关键词检索） */
export const DEFAULT_KEYWORDS = [
  '大模型',
  'LLM',
  '多模态',
  '推理',
  'AI Infra',
  '训练',
  '量化',
  'Agent',
  '强化学习',
  '具身',
  '端侧',
];

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
];

/** 噪音词：命中的岗位直接丢弃（非技术岗 / 金融量化 ≠ 模型量化） */
export const DEFAULT_NOISE = [
  '量化策略', '量化研究', '量化投资', '量化交易', '量化分析', '私募', '证券', '基金',
  '期货', '投研', '资产管理', '交易员', '行研', '销售', '运营', '市场', '人力',
  '招聘', '财务', '行政', '客服', '法务', '采购', '标注',
];

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
  { key: 'startup', name: '初创/其他', enabled: true },
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

const oneLine = (s, n = 220) => {
  const t = cleanText(s).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

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
export function parseShixiseng(html) {
  const m = String(html).match(/window\.__NUXT__=(.*?)<\/script>/s);
  if (!m) return [];
  const src = m[1].trim().replace(/;+\s*$/, '');
  const ctx = { window: {} };
  try {
    vm.createContext(ctx);
    vm.runInContext(`window.__NUXT__=${src}`, ctx, { timeout: 5000 });
  } catch {
    return [];
  }
  const found = [];
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
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(ctx.window.__NUXT__);
  return found;
}

async function fetchShixiseng(keyword, city, { timeoutMs, maxItems = 20 } = {}) {
  const url =
    `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(keyword)}` +
    `&city=${encodeURIComponent(city)}`;
  const html = await getText(url, { timeoutMs });
  return parseShixiseng(html)
    .slice(0, maxItems)
    .map((it) => ({
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
    }));
}

// ------------------------------------------------------------------ 腾讯（官方）

async function fetchTencent(keywords, { city, timeoutMs, maxPerQuery = 100 } = {}) {
  const out = [];
  for (const kw of keywords) {
    for (const attrId of ['3', '']) {
      const url =
        'https://careers.tencent.com/tencentcareer/api/post/Query' +
        `?timestamp=${Date.now()}000&keyword=${encodeURIComponent(kw)}` +
        `&pageIndex=1&pageSize=${maxPerQuery}&language=zh-cn&area=cn&attrId=${attrId}`;
      const json = await getJSON(url, {
        timeoutMs,
        headers: { referer: 'https://careers.tencent.com/' },
      });
      for (const p of json?.Data?.Posts ?? []) {
        if (city && !String(p.LocationName ?? '').includes(city)) continue;
        out.push({
          externalId: p.PostId,
          title: cleanText(p.RecruitPostName),
          companyName: '腾讯',
          city: cleanText(p.LocationName),
          type: attrId === '3' ? '实习' : '社招/校招',
          department: [cleanText(p.BGName), cleanText(p.CategoryName)].filter(Boolean).join(' · '),
          url: p.PostURL || `https://careers.tencent.com/jobdesc.html?postId=${p.PostId}`,
          jd: oneLine(p.Responsibility, 260),
          publishedAt: normDate(p.LastUpdateTime),
          source: '腾讯招聘官网',
          keyword: kw,
        });
      }
      await sleep(400);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 京东（官方）

async function fetchJd({ keywords, timeoutMs, maxItems = 200 } = {}) {
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
  const kw = keywords.map((k) => k.toLowerCase());
  const out = [];
  for (const p of all) {
    const dir = cleanText(p.jobDirection);
    // 只看实习（京东把实习岗位标在 jobDirection / planName 里，例如 TGT实习生）
    const isIntern = /实习/.test(dir) || /实习/.test(cleanText(p.planName));
    if (!isIntern) continue;
    const blob = `${p.positionName ?? ''} ${p.workContent ?? ''} ${p.qualification ?? ''}`.toLowerCase();
    if (!kw.some((k) => blob.includes(k))) continue;
    out.push({
      externalId: String(p.publishId),
      title: cleanText(p.positionName),
      companyName: '京东',
      city: '', // 京东官网在部分环境下不返回工作城市字段
      cityUnknown: true,
      type: '实习',
      department: dir,
      url: `https://campus.jd.com/#/details?id=${p.publishId}`,
      jd: oneLine(p.workContent, 300),
      requirement: oneLine(p.qualification, 200),
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
        type: '实习',
        department: [cleanText(p.bgShortName), cleanText(p.projectType)].filter(Boolean).join(' · '),
        url: `https://talent.baidu.com/jobs/detail/${p.postId}`,
        jd: oneLine(p.workContent, 300),
        requirement: oneLine(p.serviceCondition, 200),
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

export async function fetchBytedance(keywords, { timeoutMs, maxItems = 25 } = {}) {
  const { token, cookie } = await bytedanceCsrf({ timeoutMs });
  const out = [];
  const seen = new Set();
  for (const kw of keywords) {
    for (let offset = 0; offset < 150 && out.length < maxItems; offset += 10) {
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
          keyword: kw, limit: 10, offset,
          job_category_id_list: [], tag_id_list: [], location_code_list: [],
          subject_id_list: [], recruitment_id_list: ['202', '301'], portal_type: 2, job_function_id_list: [],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const json = await res.json();
      const rows = json?.data?.job_post_list ?? [];
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
          type: '实习',
          department: cleanText(p.job_category?.name),
          url: `https://jobs.bytedance.com/campus/position/${p.id}/detail`,
          jd: oneLine(p.description, 300),
          requirement: oneLine(p.requirement, 200),
          publishedAt: p.publish_time ? new Date(Number(p.publish_time)).toISOString().slice(0, 10) : '',
          source: '字节跳动校招官网',
          keyword: kw,
        });
      }
      if (rows.length < 10) break;
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
      for (let currentPage = 1; currentPage <= 3 && out.length < maxItems; currentPage++) {
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
            type: '实习',
            department: [cleanText(p.batchName), cleanText(p.department)].filter(Boolean).join(' · '),
            url: `https://campus-talent.alibaba.com/campus/position-detail?positionId=${p.id}`,
            jd: oneLine(p.requirement, 300),
            requirement: oneLine(p.description, 200),
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
  const blob = `${raw.title ?? ''} ${raw.jd ?? ''} ${raw.requirement ?? ''}`;
  const tags = classifyDirections(blob, directions);
  const tagScores = scoreDirections(blob, directions);
  const kwHit = keywords.some((k) =>
    blob.toLowerCase().includes(String(k).toLowerCase()),
  );
  // 非技术岗 / 金融量化（≠ 模型量化）直接丢弃：噪音只看标题——
  // JD 团队介绍里常自带「运营/销售」字样，按全文命中会误杀技术岗（例：大模型安全训练实习生）
  const isNoise = (noise ?? []).some((k) => String(raw.title ?? '').toLowerCase().includes(String(k).toLowerCase()));
  return {
    ...raw,
    tags,
    tagScores,
    emojis: tags.map((t) => emojiOf(t, directions)),
    // 必须命中方向标签：只靠关键词命中的（例：金融「量化实习」）不算
    matched: !isNoise && tags.length > 0,
    keywordHit: kwHit,
    noise: isNoise,
  };
}

export async function collectJobs(cfg, failures = [], opts = {}) {
  const conf = cfg.jobs ?? {};
  const city = opts.city ?? conf.city ?? DEFAULT_CITY;
  const keywords = opts.keywords ?? (conf.keywords?.length ? conf.keywords : DEFAULT_KEYWORDS);
  const directions = conf.directions?.length ? conf.directions : DEFAULT_DIRECTIONS;
  const noise = conf.noise?.length ? conf.noise : DEFAULT_NOISE;
  const patterns = conf.companyPatterns?.length ? conf.companyPatterns : DEFAULT_COMPANY_PATTERNS;
  const companies = (conf.companies?.length ? conf.companies : DEFAULT_COMPANIES).filter((c) => c.enabled !== false);
  const timeoutMs = conf.timeoutMs ?? 25000;
  const gapMs = opts.gapMs ?? conf.gapMs ?? 900;
  const maxPerCompany = opts.maxPerCompany ?? conf.maxPerCompany ?? 25;
  const notes = [];
  const byCompany = new Map();
  const add = (key, items) => {
    if (!items?.length) return;
    byCompany.set(key, [...(byCompany.get(key) ?? []), ...items]);
  };

  // 聚合站（实习僧）：一次拉成都的岗位池，供「字节/阿里兜底」和「初创」共用
  let pool = [];
  const needPool = companies.some((c) => ['startup', 'bytedance', 'alibaba'].includes(c.key));
  if (needPool && conf.shixiseng !== false) {
    for (const kw of keywords) {
      try {
        const items = await fetchShixiseng(kw, city, { timeoutMs, maxItems: conf.maxPerKeyword ?? 20 });
        pool.push(...items);
      } catch (err) {
        failures.push(`实习僧(${kw}): ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(gapMs);
    }
    const uniq = new Map();
    for (const it of pool) if (!uniq.has(it.externalId)) uniq.set(it.externalId, it);
    pool = [...uniq.values()];
    notes.push(`实习僧「${city}」池：${pool.length} 条（关键词 ${keywords.length} 个）`);
  }

  for (const company of companies) {
    const key = company.key;
    try {
      if (key === 'fintech' || company.adapter === 'shixiseng') {
        add(key, pool);
        continue;
      }
      if (key === 'startup') {
        add('startup', pool.filter((it) => !classifyCompany(it.companyName, patterns)));
        continue;
      }
      if (key === 'tencent') {
        add('tencent', await fetchTencent(keywords, { city, timeoutMs }));
        continue;
      }
      if (key === 'jd') {
        add('jd', await fetchJd({ keywords, timeoutMs }));
        continue;
      }
      if (key === 'baidu') {
        add('baidu', await fetchBaidu({ keywords, city, timeoutMs }));
        continue;
      }
      if (key === 'bytedance') {
        try {
          const items = await fetchBytedance(keywords, { timeoutMs, maxItems: maxPerCompany });
          add('bytedance', items.filter((it) => !city || String(it.city).includes(city)));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`字节跳动官网接口不可用（${msg.slice(0, 60)}），改用实习僧兜底`);
          add('bytedance', pool.filter((it) => classifyCompany(it.companyName, patterns)?.key === 'bytedance'));
        }
        continue;
      }
      if (key === 'alibaba') {
        try {
          const items = await fetchAlibaba(keywords, { timeoutMs, maxItems: maxPerCompany });
          add('alibaba', items.filter((it) => !city || String(it.city).includes(city)));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`阿里官网接口不可用（${msg.slice(0, 60)}），改用实习僧兜底`);
          add('alibaba', pool.filter((it) => classifyCompany(it.companyName, patterns)?.key === 'alibaba'));
        }
        continue;
      }
      failures.push(`未知公司配置: ${key}`);
    } catch (err) {
      failures.push(`${company.name ?? key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 归一 + 方向过滤 + 去重 + 排序
  const order = new Map(companies.map((c, i) => [c.key, i]));
  const seen = new Map();
  for (const [key, list] of byCompany) {
    for (const raw of list) {
      const item = finalize(raw, { city, directions, keywords, noise });
      if (!item.matched) continue;
      const id = `${key}:${item.externalId}`;
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        companyKey: key,
        company: item.companyName || key,
        title: item.title,
        city: item.city || '',
        cityUnknown: Boolean(item.cityUnknown || !item.city),
        type: item.type ?? '',
        department: item.department ?? '',
        tags: item.tags,
        tagScores: item.tagScores,
        emojis: item.emojis,
        salary: item.salary ?? '',
        degree: item.degree ?? '',
        publishedAt: item.publishedAt ?? '',
        url: item.url ?? '',
        jd: item.jd ?? '',
        requirement: item.requirement ?? '',
        source: item.source ?? '',
        keyword: item.keyword ?? '',
        noise: item.noise,
      });
    }
  }
  const items = [...seen.values()].sort(
    (a, b) =>
      (order.get(a.companyKey) ?? 99) - (order.get(b.companyKey) ?? 99) ||
      String(b.publishedAt).localeCompare(String(a.publishedAt)) ||
      a.title.localeCompare(b.title),
  );

  // 增量：只标「新增」，并在 state 里记已读（保留 seenKeepDays 天）
  const state = readState();
  const jobsState = (state.jobs ??= {});
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
    directions,
    companies: summary.byCompany,
    items,
    newItems,
    summary,
    notes,
    failures,
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
