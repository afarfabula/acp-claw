// 岗位语义抽取、跨来源去重与个性化匹配评分。
//
// 规则层永远可用；配置了 DEEPSEEK_API_KEY 时再用 flash 做结构化抽取。
// 模型只负责抄录页面明确出现的信息，分类和排序分数仍可由规则完整复算。

import { createHash } from 'node:crypto';
import { deepseekJSON } from './deepseek-tools.mjs';

const SEMANTIC_VERSION = 3;

export const TECHNICAL_DIRECTION_LABELS = new Set([
  '大模型', 'AI Infra', '算法/机器学习', '软件开发', '数据', '测试/运维',
]);

export const DEFAULT_FIT_PROFILE = {
  targetTags: ['大模型', 'AI Infra'],
  strongKeywords: [
    '多模态', '视觉语言', 'vlm', 'vla', '视频理解', 'video llm', '视频大模型',
    '视觉 token', 'visual token', 'token reduction', 'token compression', 'token pruning',
    '模型压缩', '量化', 'qat', 'ptq', 'w4a4', 'w3a3', '低比特', '稀疏',
    '强化学习', '后训练', 'grpo', 'dpo', 'opd', '蒸馏', '对齐',
    'vllm', 'sglang', 'kv cache', '推理优化', '推理引擎', 'cuda', 'triton',
  ],
  niceKeywords: [
    'pytorch', 'transformers', 'llama', 'qwen', 'clip', 'blip', 'florence',
    '分布式训练', '模型部署', 'tensorrt', 'agent', '智能体', '评测', 'benchmark',
    '长上下文', 'moe', 'attention', '编译器', 'kernel', 'serving',
  ],
  negativeKeywords: ['销售', '客服', '标注', '审核', '内容治理', '市场推广'],
  preferCity: '成都',
  minimumMonths: 3,
  minimumDaysPerWeek: 3,
};

const SKILL_WORDS = [
  'python', 'pytorch', 'tensorflow', 'cuda', 'c++', 'java', 'golang', 'go',
  'sql', 'spark', 'pyspark', 'docker', 'kubernetes', 'triton', 'tensorrt',
  'transformers', 'llama', 'qwen', 'vllm', 'sglang', 'deepspeed', 'megatron',
];

const TITLE_DECORATORS = [
  '日常实习', '暑期实习', '寒假实习', '校园招聘', '校招', '实习生', '实习',
  '工程师', '研发工程师', '职位', '岗位', '急招', '热招', '招聘',
];

const TITLE_STOP_WORDS = new Set([
  'ai', 'aigc', 'base', 'hc', 'jd', '技术', '研发',
]);

const GENERAL_JD_TERMS = new Set([
  '算法', '开发', '数据', '测试', '训练', '推理', '存储', '调度',
  '并行', '加速', '引擎', '基础设施', '云平台', '运营', '内容', '市场',
]);

const FIELD_WEIGHT = {
  title: 6,
  department: 4,
  tags: 3,
  requirement: 2,
  jd: 1,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function normalizeJobText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（(][^）)]{0,40}[）)]/g, ' ')
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/[^\p{L}\p{N}+#.]+/gu, '')
    .trim();
}

export function normalizeJobTitle(value) {
  let text = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/[·|｜]/g, ' ');
  for (const word of TITLE_DECORATORS) text = text.replaceAll(word.toLowerCase(), ' ');
  return text
    .replace(/[^\p{L}\p{N}+#.]+/gu, '')
    .trim();
}

function bigrams(text) {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length < 2) return new Set(chars);
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

export function jobTitleSimilarity(a, b) {
  const left = normalizeJobTitle(a);
  const right = normalizeJobTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const x = bigrams(left);
  const y = bigrams(right);
  let overlap = 0;
  for (const token of x) if (y.has(token)) overlap += 1;
  return (2 * overlap) / Math.max(1, x.size + y.size);
}

export function canonicalJobUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.username = '';
    url.password = '';
    const drop = /^(utm_.+|from|source|spread|tracking|_tracking|recomid|sourcejobid|share|spm)$/i;
    for (const key of [...url.searchParams.keys()]) {
      if (drop.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = url.hash.replace(/\?.*$/, (query) => {
      const params = new URLSearchParams(query.slice(1));
      for (const key of [...params.keys()]) if (drop.test(key)) params.delete(key);
      params.sort();
      const next = params.toString();
      return next ? `?${next}` : '';
    });
    return url.toString().replace(/\/$/, '');
  } catch {
    return text.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

export function stableId(value, prefix = 'job') {
  return `${prefix}:${createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 16)}`;
}

function keywordPresent(haystack, keyword) {
  return haystack.includes(String(keyword ?? '').toLowerCase());
}

function directionScores(item, directions) {
  const fields = {
    title: String(item.title ?? '').toLowerCase(),
    department: String(item.department ?? '').toLowerCase(),
    tags: (item.tags ?? []).join(' ').toLowerCase(),
    requirement: String(item.requirement ?? '').toLowerCase(),
    jd: String(item.jd ?? '').toLowerCase(),
  };
  const out = {};
  for (const direction of directions) {
    let score = 0;
    const hits = [];
    for (const [field, text] of Object.entries(fields)) {
      for (const keyword of direction.keywords ?? []) {
        const k = String(keyword).toLowerCase();
        if (!keywordPresent(text, k)) continue;
        let weight = FIELD_WEIGHT[field] ?? 1;
        if (field === 'jd' && GENERAL_JD_TERMS.has(k)) weight *= 0.35;
        score += weight;
        hits.push({ field, keyword: k, weight });
      }
    }
    out[direction.label] = { score: Math.round(score * 10) / 10, hits };
  }
  return out;
}

function extractMonths(text) {
  const m = text.match(/(?:实习|至少|连续)[^。\n]{0,12}?(\d+(?:\.\d+)?)\s*(?:个)?月/);
  return m ? Number(m[1]) : null;
}

function extractDaysPerWeek(text) {
  const m = text.match(/每周[^。\n]{0,10}?(\d+)\s*天/);
  return m ? Number(m[1]) : null;
}

function extractDateAfter(text, labels) {
  const re = new RegExp(`(?:${labels.join('|')})[：:\\s]*((?:20\\d{2})[-/.年](?:\\d{1,2})[-/.月](?:\\d{1,2}))`);
  const m = text.match(re);
  if (!m) return '';
  const parts = m[1].match(/\d+/g);
  if (!parts || parts.length < 3) return '';
  return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
}

function extractExplicitSalary(text) {
  const patterns = [
    /(?:日薪|时薪|月薪|年薪|实习工资|薪资|薪酬|待遇|报酬)[^。\n；;]{0,32}?\d+(?:\.\d+)?\s*(?:[kK千万])?\s*(?:[-~—–至]\s*\d+(?:\.\d+)?\s*(?:[kK千万])?)?\s*(?:元)?\s*(?:\/\s*(?:天|日|月|年|周|小时|时))?/,
    /\d+(?:\.\d+)?\s*(?:[kK千万])?\s*(?:[-~—–至]\s*\d+(?:\.\d+)?\s*(?:[kK千万])?)?\s*元?\s*\/\s*(?:天|日|月|年|周|小时|时)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return '';
}

export function deriveRuleFacts(item, {
  directions = [],
  nonTechKeywords = [],
} = {}) {
  const title = String(item.title ?? '');
  const department = String(item.department ?? '');
  const text = `${title}\n${department}\n${item.requirement ?? ''}\n${item.jd ?? ''}`;
  const scores = directionScores(item, directions);
  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  const tags = ranked
    .filter(([, fact]) => fact.score >= 3)
    .map(([label]) => label);
  const titleDept = `${title} ${department}`.toLowerCase();
  const nonTechHit = nonTechKeywords.find((keyword) => titleDept.includes(String(keyword).toLowerCase()));
  const technicalTags = tags.filter((tag) => TECHNICAL_DIRECTION_LABELS.has(tag));
  const skillText = text.toLowerCase();
  return {
    source: 'rules',
    isJob: Boolean(title),
    isInternship: /实习|intern/i.test(text),
    isTechnical: !nonTechHit && technicalTags.length > 0,
    nonTechHit: nonTechHit ?? '',
    primaryDirection: ranked[0]?.[0] ?? '',
    directionScores: Object.fromEntries(ranked),
    tags,
    skills: SKILL_WORDS.filter((word) => skillText.includes(word)),
    months: extractMonths(text),
    daysPerWeek: extractDaysPerWeek(text),
    degree: String(item.degree ?? ''),
    deadline: extractDateAfter(text, ['截止日期', '截止时间', '截止']),
    publishedAt: String(item.publishedAt ?? '') || extractDateAfter(text, ['发布时间', '发布日期', '更新于', '刷新']),
    salary: extractExplicitSalary(text),
    city: String(item.city ?? ''),
    company: String(item.companyName ?? item.company ?? ''),
    title,
    fitHighlights: [],
    riskFlags: nonTechHit ? [`标题/部门命中非技术词：${nonTechHit}`] : [],
    confidence: 0.7,
  };
}

function normalizeLLMFacts(raw = {}) {
  const strings = (value, limit = 12) => (Array.isArray(value) ? value : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
  return {
    source: 'llm',
    isJob: typeof raw.is_job === 'boolean' ? raw.is_job : undefined,
    isInternship: typeof raw.is_internship === 'boolean' ? raw.is_internship : undefined,
    isTechnical: typeof raw.is_technical === 'boolean' ? raw.is_technical : undefined,
    primaryDirection: String(raw.primary_direction ?? '').trim(),
    primaryRole: String(raw.primary_role ?? '').trim(),
    skills: strings(raw.skills),
    months: Number.isFinite(Number(raw.months)) && Number(raw.months) > 0 ? Number(raw.months) : null,
    daysPerWeek: Number.isFinite(Number(raw.days_per_week)) && Number(raw.days_per_week) > 0
      ? Number(raw.days_per_week)
      : null,
    degree: String(raw.degree ?? '').trim(),
    deadline: String(raw.deadline ?? '').trim(),
    publishedAt: String(raw.published_at ?? '').trim(),
    salary: String(raw.salary ?? '').trim(),
    city: String(raw.city ?? '').trim(),
    company: String(raw.company ?? '').trim(),
    title: String(raw.title ?? '').trim(),
    fitHighlights: strings(raw.fit_highlights, 6),
    riskFlags: strings(raw.risk_flags, 6),
    confidence: Number.isFinite(Number(raw.confidence)) ? clamp(Number(raw.confidence), 0, 1) : 0.6,
  };
}

function compactRecord(record, ref, maxJdChars) {
  return {
    ref,
    url: record.url ?? '',
    title: String(record.title ?? '').slice(0, 300),
    company: String(record.companyName ?? record.company ?? '').slice(0, 200),
    city: String(record.city ?? '').slice(0, 100),
    department: String(record.department ?? '').slice(0, 300),
    published_at: String(record.publishedAt ?? '').slice(0, 30),
    salary: String(record.salary ?? '').slice(0, 120),
    requirement: String(record.requirement ?? '').slice(0, Math.min(1200, maxJdChars)),
    jd: String(record.jd ?? '').slice(0, maxJdChars),
  };
}

/**
 * 调用 flash 对一批岗位做结构化抽取。调用方负责缓存与降级。
 */
export async function extractJobFactsWithLLM(records, {
  model = 'deepseek-flash',
  apiKeyEnv = 'DEEPSEEK_API_KEY',
  maxJdChars = 1800,
  directions = [],
  batchSize = 6,
  onBatch,
} = {}) {
  const labels = directions.map((d) => d.label);
  const facts = new Map();
  const failures = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const system = [
    '你是严谨的招聘岗位信息抽取器。只抄录输入中明确出现的信息，绝不补全、猜测或编造。',
    '区分岗位性质：算法/工程研发为技术岗；产品运营、内容审核、数据标注、销售等为运营或非技术岗。',
    `primary_direction 只能取：${labels.length ? labels.join('、') : '大模型、AI Infra、算法/机器学习、软件开发、数据、测试/运维、产品/运营'}。`,
    'primary_direction 必须按岗位的主要交付判断：前端、后端、客户端、全栈、测试、运维归入软件开发或测试/运维，即使业务是 AI/LLM/Agent；只有核心工作是模型/算法研究或训练时才算大模型或算法/机器学习；只有核心工作是推理、训练框架、编译器、算子、部署优化时才算 AI Infra。',
    '不要因为 JD 的团队介绍、产品背景、加分项里出现 AI、LLM、Agent、多模态，就改变岗位主方向。',
    'salary 只填页面明确写出的薪资，没有就填空字符串；不要根据公司或城市估计。',
    'published_at 只填发布时间，deadline 只填申请截止日期；日期统一 YYYY-MM-DD，不确定填空字符串。',
    'months/days_per_week 是实习要求；不确定填 null。',
    'fit_highlights 只写岗位里能直接证明以下方向之一的原文要点：视频/多模态大模型、视觉 token 或上下文压缩、量化/低比特、强化学习/后训练、推理框架/推理优化。没有就直接给空数组，不要复述普通职责。',
    '返回严格 JSON：{"items":[{...}]}，每个输入 ref 必须且只能出现一次。',
    '每项字段：ref,is_job,is_internship,is_technical,primary_direction,primary_role,skills,months,days_per_week,degree,deadline,published_at,salary,city,company,title,fit_highlights,risk_flags,confidence。',
  ].join('\n');

  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const prompt = JSON.stringify({
      task: '逐一抽取岗位字段。输入可能含网页导航、推荐岗位等噪音，只保留目标招聘岗位。',
      items: batch.map((record, index) => compactRecord(record, String(index), maxJdChars)),
    });
    try {
      const result = await deepseekJSON({
        system,
        user: prompt,
        model,
        apiKeyEnv,
        maxTokens: 4096,
      });
      const rows = Array.isArray(result.data?.items) ? result.data.items : [];
      for (const row of rows) {
        const index = Number(row?.ref);
        if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;
        facts.set(records[start + index], normalizeLLMFacts(row));
      }
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        usage[key] += Number(result.usage?.[key] ?? 0);
      }
      onBatch?.({ start, size: batch.length, ok: true });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      onBatch?.({ start, size: batch.length, ok: false, error: failures.at(-1) });
    }
  }
  return { facts, failures, usage };
}

function analysisHash(item) {
  return createHash('sha1')
    .update([
      `v${SEMANTIC_VERSION}`,
      item.title, item.companyName ?? item.company, item.city, item.department,
      item.salary, item.publishedAt, item.jd, item.requirement,
    ].map((x) => String(x ?? '')).join('\u0000'))
    .digest('hex');
}

function mergeFacts(rule, llm) {
  const merged = { ...rule, rule, source: llm ? 'llm+rules' : 'rules' };
  if (llm) {
    for (const [key, value] of Object.entries(llm)) {
      if (value == null) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      if (Array.isArray(value) && !value.length) continue;
      merged[key] = value;
    }
  }
  if (llm?.primaryDirection && rule?.tags && !rule.tags.includes(llm.primaryDirection)) {
    merged.tags = [llm.primaryDirection, ...rule.tags];
  }
  if (llm?.isTechnical === false) merged.isTechnical = false;
  if (llm?.isJob === false) merged.isJob = false;
  return merged;
}

/**
 * 对现有岗位做带缓存的语义增强。缓存按岗位内容 hash 失效。
 */
export async function enrichJobsSemantically(items, {
  cache = {},
  enabled = true,
  model = 'deepseek-flash',
  apiKeyEnv = 'DEEPSEEK_API_KEY',
  maxJdChars = 1800,
  batchSize = 6,
  directions = [],
  nonTechKeywords = [],
  log = () => {},
} = {}) {
  const rules = new Map();
  const pending = [];
  let cacheHits = 0;
  for (const item of items) {
    const rule = deriveRuleFacts(item, { directions, nonTechKeywords });
    rules.set(item, rule);
    const hash = analysisHash(item);
    const hit = cache[item.id];
    if (hit?.hash === hash && hit?.facts) {
      rules.set(item, mergeFacts(rule, hit.facts));
      cacheHits += 1;
    } else if (enabled && !cache[item.id]) {
      pending.push(item);
    } else if (enabled) {
      pending.push(item);
    }
  }

  let llmFacts = new Map();
  let extraction = { failures: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  if (enabled && pending.length) {
    extraction = await extractJobFactsWithLLM(pending, {
      model,
      apiKeyEnv,
      maxJdChars,
      directions,
      batchSize,
      onBatch: ({ ok, size, error }) => {
        log(ok ? `语义抽取 ${size} 条` : `语义抽取 ${size} 条失败：${error}`);
      },
    });
    llmFacts = extraction.facts;
    for (const item of pending) {
      const llm = llmFacts.get(item);
      cache[item.id] = {
        hash: analysisHash(item),
        analyzedAt: new Date().toISOString(),
        facts: llm ? {
          is_job: llm.isJob,
          is_internship: llm.isInternship,
          is_technical: llm.isTechnical,
          primary_direction: llm.primaryDirection,
          primary_role: llm.primaryRole,
          skills: llm.skills,
          months: llm.months,
          days_per_week: llm.daysPerWeek,
          degree: llm.degree,
          deadline: llm.deadline,
          published_at: llm.publishedAt,
          salary: llm.salary,
          city: llm.city,
          company: llm.company,
          title: llm.title,
          fit_highlights: llm.fitHighlights,
          risk_flags: llm.riskFlags,
          confidence: llm.confidence,
        } : null,
      };
    }
  }

  const enriched = items.map((item) => {
    const llm = llmFacts.get(item) ?? (cache[item.id]?.facts ? normalizeLLMFacts(cache[item.id].facts) : null);
    const facts = mergeFacts(rules.get(item), llm);
    const technicalTags = [...new Set(facts.tags ?? [])].filter((tag) => TECHNICAL_DIRECTION_LABELS.has(tag));
    return {
      ...item,
      tags: technicalTags.length ? technicalTags : (facts.isTechnical ? item.tags : []),
      title: item.title || facts.title,
      company: item.company || facts.company,
      city: item.city || facts.city,
      salary: item.salary || facts.salary || '',
      degree: item.degree || facts.degree || '',
      publishedAt: item.publishedAt || facts.publishedAt || '',
      role: facts.primaryRole || '',
      skills: [...new Set([...(item.skills ?? []), ...(facts.skills ?? [])])],
      months: Number(facts.months) > 0 ? Number(facts.months) : null,
      daysPerWeek: Number(facts.daysPerWeek) > 0 ? Number(facts.daysPerWeek) : null,
      deadline: facts.deadline || item.deadline || '',
      semantic: {
        source: facts.source,
        confidence: facts.confidence,
        primaryDirection: facts.primaryDirection,
        isTechnical: facts.isTechnical,
        isInternship: facts.isInternship,
        isJob: facts.isJob,
        nonTechHit: facts.nonTechHit || '',
        directionScores: facts.directionScores ?? {},
        highlights: facts.fitHighlights ?? [],
        risks: facts.riskFlags ?? [],
      },
    };
  });
  return {
    items: enriched,
    cache,
    stats: {
      rules: items.length,
      cacheHits,
      llmAnalyzed: llmFacts.size,
      failures: extraction.failures.length,
      usage: extraction.usage,
    },
  };
}

function sourcePriority(item) {
  const source = String(item.source ?? '');
  if (/DeepSeek|网页发现/.test(source)) return 2;
  if (/官网|官方/.test(source)) return 4;
  if (/实习僧/.test(source)) return 3;
  return 1;
}

function mergeDuplicate(base, other) {
  const merged = { ...other, ...base };
  for (const field of [
    'publishedAt', 'department', 'degree', 'jd', 'requirement', 'deadline',
    'role', 'months', 'daysPerWeek', 'city',
  ]) {
    if ((merged[field] == null || merged[field] === '') && other[field] != null && other[field] !== '') {
      merged[field] = other[field];
    }
  }
  merged.tags = [...new Set([...(base.tags ?? []), ...(other.tags ?? [])])];
  merged.skills = [...new Set([...(base.skills ?? []), ...(other.skills ?? [])])];
  if (!base.salary && other.salary) {
    merged.salary = other.salary;
    merged.salarySource = 'aggregate';
    merged.salaryEvidenceSource = other.source;
    merged.salaryReported = other.salaryReported || other.salary;
  }
  merged.mergedSources = [...new Set([
    ...(base.mergedSources ?? [base.source]),
    ...(other.mergedSources ?? [other.source]),
  ])].filter(Boolean);
  return merged;
}

/**
 * URL 精确去重 + 同公司/城市标题模糊去重。官网记录优先保留。
 */
export function mergeJobDuplicates(items, { titleThreshold = 0.88 } = {}) {
  const ordered = [...items].sort((a, b) => sourcePriority(b) - sourcePriority(a));
  const kept = [];
  const byUrl = new Map();
  const buckets = new Map();
  let duplicates = 0;
  for (const item of ordered) {
    const canonicalUrl = canonicalJobUrl(item.url);
    if (canonicalUrl && byUrl.has(canonicalUrl)) {
      const index = byUrl.get(canonicalUrl);
      kept[index] = mergeDuplicate(kept[index], item);
      duplicates += 1;
      continue;
    }
    const company = normalizeJobText(item.company);
    const city = normalizeJobText(item.city);
    const bucketKey = `${company}|${city}`;
    const list = buckets.get(bucketKey) ?? [];
    const similarIndex = list.find(({ title }) => jobTitleSimilarity(title, item.title) >= titleThreshold)?.index;
    if (similarIndex != null) {
      kept[similarIndex] = mergeDuplicate(kept[similarIndex], item);
      duplicates += 1;
    } else {
      const index = kept.length;
      kept.push(item);
      if (canonicalUrl) byUrl.set(canonicalUrl, index);
      list.push({ title: item.title, index });
      buckets.set(bucketKey, list);
    }
  }
  return { items: kept, duplicates };
}

function keywordHits(text, keywords) {
  const haystack = String(text ?? '').toLowerCase();
  return [...new Set((keywords ?? []).filter((word) => haystack.includes(String(word).toLowerCase())))];
}

function recencyPoints(date, now = Date.now()) {
  const time = Date.parse(String(date ?? ''));
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (now - time) / 86400_000);
  if (days <= 7) return 7;
  if (days <= 21) return 5;
  if (days <= 45) return 3;
  if (days <= 90) return 1;
  return 0;
}

/**
 * 可解释的 0-100 匹配分。方向 20、目标标签 24、强关键词 40、技能 12。
 */
export function scoreJobFit(item, profile = DEFAULT_FIT_PROFILE, { now = Date.now() } = {}) {
  const text = [
    item.title, item.department, item.role, item.jd, item.requirement,
    ...(item.tags ?? []), ...(item.skills ?? []),
  ].join('\n');
  const titleDept = `${item.title ?? ''} ${item.department ?? ''} ${item.role ?? ''}`;
  const primaryDirection = item.semantic?.primaryDirection ?? '';
  const primaryTarget = Boolean(primaryDirection && profile.targetTags?.includes(primaryDirection));
  const targetTags = (item.tags ?? []).filter((tag) => profile.targetTags?.includes(tag));
  const strongHits = keywordHits(text, profile.strongKeywords);
  const strongTitleHits = keywordHits(titleDept, profile.strongKeywords);
  const niceHits = keywordHits(text, profile.niceKeywords);
  const negativeTitle = keywordHits(titleDept, profile.negativeKeywords);
  const negativeBody = keywordHits(`${item.jd ?? ''} ${item.requirement ?? ''}`, profile.negativeKeywords);
  const skillHits = keywordHits((item.skills ?? []).join(' '), profile.niceKeywords);
  const reasons = [];
  const risks = [];
  let score = 0;

  if (item.semantic?.isTechnical === false) {
    score -= 60;
    risks.push('语义判断为非技术岗');
  }
  if (primaryTarget) {
    score += 28;
    reasons.push(`岗位主方向匹配：${primaryDirection}`);
  } else if (targetTags.length) {
    score += 6;
    reasons.push(`岗位涉及：${targetTags.join(' / ')}`);
  }
  const tagPoints = primaryTarget ? Math.min(16, targetTags.length * 8) : 0;
  score += tagPoints;

  const bodyStrong = strongHits.filter((word) => !strongTitleHits.includes(word));
  const strongPoints = Math.min(48, strongTitleHits.length * 12 + bodyStrong.length * 5);
  score += strongPoints;
  if (strongTitleHits.length) reasons.push(`标题直接命中：${strongTitleHits.slice(0, 4).join('、')}`);
  else if (bodyStrong.length) reasons.push(`JD 相关：${bodyStrong.slice(0, 4).join('、')}`);

  const nicePoints = Math.min(8, niceHits.length * 2);
  const skillPoints = Math.min(12, skillHits.length * 3);
  score += nicePoints + skillPoints;
  if (niceHits.length) reasons.push(`相关技能：${niceHits.slice(0, 5).join('、')}`);

  if (profile.preferCity && String(item.city ?? '').includes(profile.preferCity)) {
    score += 5;
    reasons.push(`城市：${profile.preferCity}`);
  }
  const recent = recencyPoints(item.publishedAt, now);
  score += recent;
  if (recent >= 5) reasons.push('近期发布/刷新');

  if (item.salaryDailyMin != null && item.salaryDailyMin >= 200) score += 3;
  if (item.months != null && profile.minimumMonths && item.months < profile.minimumMonths) {
    score -= 6;
    risks.push(`要求实习 ${item.months} 个月`);
  }
  if (item.daysPerWeek != null && profile.minimumDaysPerWeek && item.daysPerWeek < profile.minimumDaysPerWeek) {
    score -= 3;
    risks.push(`每周 ${item.daysPerWeek} 天`);
  }
  if (negativeTitle.length) {
    score -= 30;
    risks.push(`标题/部门出现降权词：${negativeTitle.join('、')}`);
  } else if (negativeBody.length) {
    score -= Math.min(20, negativeBody.length * 4);
    risks.push(`JD 出现降权词：${negativeBody.slice(0, 4).join('、')}`);
  }

  const fitScore = Math.round(clamp(score, 0, 100));
  const fitTier = fitScore >= 70 ? 'high' : fitScore >= 45 ? 'medium' : 'low';
  return {
    fitScore,
    fitTier,
    fitReasons: [...new Set([...(item.semantic?.highlights ?? []), ...reasons])].slice(0, 5),
    fitRisks: [...new Set([...(item.semantic?.risks ?? []), ...risks])].slice(0, 5),
    fitEvidence: {
      targetTags,
      strongKeywords: strongHits,
      niceKeywords: niceHits,
      skills: skillHits,
      negativeKeywords: [...new Set([...negativeTitle, ...negativeBody])],
    },
  };
}

export function decorateJobsWithFit(items, profile = DEFAULT_FIT_PROFILE) {
  return items.map((item) => ({ ...item, ...scoreJobFit(item, profile) }));
}
