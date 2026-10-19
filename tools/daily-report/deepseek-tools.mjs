// DeepSeek Search / Fetch / JSON 调用封装。
//
// Search 与 Fetch 都是独立按次计费的只读接口；JSON 抽取走普通 Chat Completions。
// 密钥只从环境变量读取，不写进日志或数据文件。

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiKey(opts = {}) {
  const envName = opts.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const key = process.env[envName];
  if (!key) throw new Error(`缺少环境变量 ${envName}`);
  return key;
}

async function requestJSON(path, body, {
  apiKeyEnv = 'DEEPSEEK_API_KEY',
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 45000,
  retries = 2,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey({ apiKeyEnv })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`DeepSeek HTTP ${res.status}${text ? ` :: ${text.slice(0, 300)}` : ''}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : {};
    } catch (err) {
      lastError = err;
      const retryable = err?.status == null || err.status === 408 || err.status === 429 || err.status >= 500;
      if (attempt >= retries || !retryable) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function deepseekSearch(query, opts = {}) {
  const json = await requestJSON('/v1/tools/search', {
    query,
    count: Math.max(1, Math.min(50, Number(opts.count ?? 10))),
    need_content: Boolean(opts.needContent),
    ...(opts.oriQuestion ? { ori_question: opts.oriQuestion } : {}),
    ...(opts.localization ? { localization: opts.localization } : {}),
  }, opts);
  return Array.isArray(json?.results) ? json.results : [];
}

export async function deepseekFetch(url, opts = {}) {
  return requestJSON('/v1/tools/fetch', { url }, {
    timeoutMs: 60000,
    ...opts,
  });
}

function parseJSONContent(content) {
  const raw = String(content ?? '').trim();
  if (!raw) throw new Error('模型返回空内容');
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
    throw new Error('模型返回不是 JSON');
  }
}

/**
 * 要求模型返回 JSON。JSON mode 关闭思考过程，适合做字段抽取和分类。
 */
export async function deepseekJSON({ system, user, model = 'deepseek-flash', maxTokens = 4096, ...opts }) {
  const json = await requestJSON('/v1/chat/completions', {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    // 纯字段抽取不需要思维链；关闭后更便宜，也避免 completion token 被推理占满。
    thinking: { type: 'disabled' },
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
  }, {
    timeoutMs: 90000,
    ...opts,
  });
  const content = json?.choices?.[0]?.message?.content;
  return {
    data: parseJSONContent(content),
    usage: json?.usage ?? null,
  };
}
