// DeepSeek Search + Fetch 的招聘发现层。
//
// 搜索只负责发现候选，Fetch 成功且模型确认是目标城市实习后才进入后续归并。
// 招聘官网的专用 API 仍是权威主源；这里补的是长尾公司和官网没有直接适配的页面。

import {
  canonicalJobUrl,
  extractJobFactsWithLLM,
  normalizeJobTitle,
  stableId,
} from './jobs-intelligence.mjs';
import { deepseekFetch, deepseekSearch } from './deepseek-tools.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_SEARCH_CONFIG = {
  enabled: false,
  mode: 'shadow',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  model: 'deepseek-flash',
  countPerQuery: 10,
  maxQueries: 12,
  maxFetches: 16,
  fetchConcurrency: 3,
  minRerankScore: 1.5,
  minAuthority: 2,
  minConfidence: 0.55,
  requireFetch: true,
  queries: [
    'site:jobs.bytedance.com/campus/position {city} 大模型 多模态 实习',
    'site:campus-talent.alibaba.com {city} 大模型 算法 实习',
    'site:careers.tencent.com {city} 技术 实习',
    'site:campus.jd.com {city} 技术 实习',
    'site:www.shixiseng.com/intern {city} 多模态 大模型 实习',
    '{city} 多模态 视觉语言 视频理解 实习 招聘',
    '{city} AI Infra 推理优化 模型量化 实习',
    '{city} 强化学习 后训练 GRPO 实习',
    '{city} VLM 模型压缩 CUDA 实习',
    '{city} vLLM SGLang 推理框架 实习',
    'site:mp.weixin.qq.com {city} 大模型 算法 实习 招聘',
    '{city} 人工智能 实验室 算法 实习生 招聘',
  ],
};

const JOB_MARKER = /实习|intern|校招|校园招聘|招聘|应届/i;
const NON_JOB_MARKER = /(?:课程|培训|面经|题库|排行榜|论文|新闻|资讯)(?!.*(?:招聘|实习))/i;

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_SEARCH_CONFIG,
    ...config,
    queries: config.queries?.length ? config.queries : DEFAULT_SEARCH_CONFIG.queries,
  };
}

export function buildSearchQueries(city, config = {}) {
  const merged = mergeConfig(config);
  return merged.queries
    .map((query) => String(query).replaceAll('{city}', city))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(merged.maxQueries ?? 12)));
}

function searchableText(result) {
  return `${result.title ?? ''}\n${result.snippet ?? ''}\n${result.summary ?? ''}`;
}

export function candidateAllowed(result, config = {}) {
  const text = searchableText(result);
  if (!result?.url || !JOB_MARKER.test(text)) return false;
  if (NON_JOB_MARKER.test(result.title ?? '')) return false;
  const score = Number(result.rerank_score ?? 0);
  const authority = Number(result.authority ?? -1);
  if (score < Number(config.minRerankScore ?? 1.5)) return false;
  if (authority !== -1 && authority < Number(config.minAuthority ?? 2)) return false;
  return true;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
      await sleep(220);
    }
  });
  await Promise.all(workers);
  return out;
}

function resultDate(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

function cleanMarkdown(value) {
  return String(value ?? '')
    .replace(/\\#/g, '#')
    .replace(/\\-/g, '-')
    .replace(/\\\//g, '/')
    .replace(/\\:/g, ':')
    .replace(/\\\./g, '.')
    .replace(/\\\+/g, '+')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 执行 Search/Fetch 发现。返回值不直接修改输入，调用方根据 mode 决定是否合入。
 */
export async function discoverJobs(city, {
  config = {},
  knownUrls = [],
  directions = [],
  onProgress = () => {},
} = {}) {
  const conf = mergeConfig(config);
  const queries = buildSearchQueries(city, conf);
  const known = new Set(knownUrls.map(canonicalJobUrl).filter(Boolean));
  const failures = [];
  const searches = [];

  if (!conf.enabled) {
    return {
      items: [],
      stats: { enabled: false, queries: 0, searchResults: 0, uniqueUrls: 0, fetched: 0, verified: 0, rejected: 0 },
      failures,
      queries,
    };
  }

  onProgress(`搜索 ${queries.length} 组招聘查询`);
  const searchRows = await mapLimit(queries, 2, async (query) => {
    try {
      const rows = await deepseekSearch(query, {
        count: conf.countPerQuery,
        needContent: false,
        apiKeyEnv: conf.apiKeyEnv,
        retries: 2,
      });
      searches.push({ query, count: rows.length });
      return rows.map((row) => ({ ...row, query }));
    } catch (err) {
      failures.push(`搜索「${query}」: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });

  const byUrl = new Map();
  for (const row of searchRows.flat()) {
    if (!candidateAllowed(row, conf)) continue;
    const canonical = canonicalJobUrl(row.url);
    if (!canonical || known.has(canonical)) continue;
    const prev = byUrl.get(canonical);
    if (!prev || Number(row.rerank_score ?? 0) > Number(prev.rerank_score ?? 0)) byUrl.set(canonical, row);
  }

  const candidates = [...byUrl.values()]
    .sort((a, b) =>
      Number(b.rerank_score ?? 0) - Number(a.rerank_score ?? 0) ||
      Number(b.authority ?? -1) - Number(a.authority ?? -1),
    )
    .slice(0, Math.max(0, Number(conf.maxFetches ?? 16)));

  onProgress(`Fetch ${candidates.length} 个去重后的招聘候选`);
  const fetched = await mapLimit(candidates, conf.fetchConcurrency, async (candidate) => {
    try {
      const page = await deepseekFetch(candidate.url, {
        apiKeyEnv: conf.apiKeyEnv,
        retries: 1,
      });
      const content = cleanMarkdown(page?.content);
      if (!content) throw new Error('页面正文为空');
      return {
        candidate,
        page: { title: page?.title ?? candidate.title, content },
      };
    } catch (err) {
      failures.push(`抓取 ${candidate.url}: ${err instanceof Error ? err.message : String(err)}`);
      return { candidate, page: null };
    }
  });

  const usable = fetched.filter((x) => x.page);
  const records = usable.map(({ candidate, page }) => ({
    externalId: stableId(canonicalJobUrl(candidate.url), 'web'),
    title: page.title || candidate.title || '',
    companyName: candidate.site_name ?? '',
    city: '',
    type: '实习',
    department: '',
    salary: '',
    url: candidate.url,
    jd: page.content.slice(0, 6000),
    requirement: '',
    publishedAt: resultDate(candidate.date),
    source: `网页发现${candidate.site_name ? ` · ${candidate.site_name}` : ''}`,
    keyword: candidate.query,
    publisher: candidate.site_name ?? '',
    discovery: {
      query: candidate.query,
      rerankScore: Number(candidate.rerank_score ?? 0),
      authority: Number(candidate.authority ?? -1),
      fetched: true,
      fetchedAt: new Date().toISOString(),
    },
  }));

  let facts = new Map();
  if (records.length) {
    onProgress(`语义核验 ${records.length} 个网页岗位`);
    const extracted = await extractJobFactsWithLLM(records, {
      model: conf.model,
      apiKeyEnv: conf.apiKeyEnv,
      maxJdChars: 2600,
      directions,
      batchSize: 4,
      onBatch: ({ ok, size, error }) => {
        if (!ok) failures.push(`网页语义核验 ${size} 条: ${error}`);
      },
    });
    facts = extracted.facts;
    failures.push(...extracted.failures);
  }

  const items = [];
  const rejected = [];
  for (const record of records) {
    const extracted = facts.get(record);
    const text = `${extracted?.title ?? record.title}\n${record.jd}`;
    const extractedCity = extracted?.city ?? record.city;
    const isInternship = extracted?.isInternship ?? JOB_MARKER.test(text);
    const isJob = extracted?.isJob ?? true;
    const isTechnical = extracted?.isTechnical ?? !/运营|销售|审核|标注|客服/.test(extracted?.primaryDirection ?? '');
    const cityOk = !city || String(extractedCity ?? '').includes(city) || String(record.jd).includes(city);
    const confidence = extracted?.confidence ?? 0;
    if (!isJob || !isInternship || !isTechnical || !cityOk || confidence < Number(conf.minConfidence ?? 0.55)) {
      rejected.push({
        url: record.url,
        title: extracted?.title || record.title,
        reasons: [
          !isJob ? '不是岗位' : '',
          !isInternship ? '不是实习' : '',
          !isTechnical ? '非技术岗' : '',
          !cityOk ? `非${city}` : '',
          confidence < Number(conf.minConfidence ?? 0.55) ? `置信度低(${confidence})` : '',
        ].filter(Boolean),
      });
      continue;
    }
    items.push({
      ...record,
      title: extracted?.title || record.title,
      companyName: extracted?.company || record.companyName,
      city: extractedCity || city,
      salary: extracted?.salary || record.salary,
      degree: extracted?.degree || '',
      publishedAt: extracted?.publishedAt || record.publishedAt,
      deadline: extracted?.deadline || '',
      months: extracted?.months ?? null,
      daysPerWeek: extracted?.daysPerWeek ?? null,
      skills: extracted?.skills ?? [],
      role: extracted?.primaryRole ?? '',
      semanticDirection: extracted?.primaryDirection ?? '',
      verification: conf.requireFetch ? 'deepseek-fetch' : 'search-result',
      discoveryConfidence: confidence,
    });
  }

  const successfulFetches = usable.length;
  const costEstimate = ((searches.filter((x) => x.count > 0).length + successfulFetches) * 5) / 1000;
  return {
    items,
    stats: {
      enabled: true,
      mode: conf.mode,
      queries: queries.length,
      searchResults: searches.reduce((sum, x) => sum + x.count, 0),
      uniqueUrls: byUrl.size,
      fetched: successfulFetches,
      verified: items.length,
      rejected: rejected.length,
      costEstimate,
    },
    rejected: rejected.slice(0, 20),
    failures,
    queries,
  };
}
