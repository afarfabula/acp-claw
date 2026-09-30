// 采集：天气 / API 余额 / 论文 / Infra 动态 / 项目进展
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UA = 'acp-claw-daily-report/1.0 (+https://github.com/afarfabula/acp-claw)';

async function getJSON(url, { headers = {}, timeoutMs = 20000, method = 'GET' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function getText(url, { timeoutMs = 25000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * arXiv 对同一 IP 限流（实测连续 3 次查询就返回 429），所以这里带退避重试。
 * arXiv 官方建议请求间隔 3 秒以上。
 */
async function getTextRetry(url, { attempts = 3, timeoutMs = 30000, gapMs = 3500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(gapMs * i);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/atom+xml' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('请求失败');
}

/** 每个采集项独立失败，不影响整体 */
async function guard(name, failures, fn) {
  try {
    return await fn();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------- 天气

const WMO = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
};

export async function collectWeather(cfg, failures) {
  if (cfg.weather?.enabled === false) return null;
  return guard('weather', failures, async () => {
    const { latitude, longitude } = cfg.weather;
    if (latitude == null || longitude == null) throw new Error('缺少经纬度');
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${latitude}&longitude=${longitude}` +
      '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      `&forecast_days=3&timezone=${encodeURIComponent(cfg.timezone)}`;
    const j = await getJSON(url);
    const hours = Number(cfg.weather.hours ?? 24);
    const now = new Date();
    const startIdx = Math.max(
      0,
      j.hourly.time.findIndex((t) => new Date(`${t}:00+08:00`) >= new Date(now.getTime() - 3600_000)),
    );
    const rows = [];
    for (let i = startIdx; i < Math.min(startIdx + hours, j.hourly.time.length); i += 1) {
      rows.push({
        time: j.hourly.time[i].slice(11, 16),
        date: j.hourly.time[i].slice(0, 10),
        temp: j.hourly.temperature_2m[i],
        feels: j.hourly.apparent_temperature[i],
        pop: j.hourly.precipitation_probability[i],
        precip: j.hourly.precipitation[i],
        code: j.hourly.weather_code[i],
        wind: j.hourly.wind_speed_10m[i],
      });
    }
    const temps = rows.map((r) => r.temp).filter((v) => v != null);
    const pops = rows.map((r) => r.pop).filter((v) => v != null);
    const maxPopRow = rows.reduce((a, b) => ((b.pop ?? 0) > (a?.pop ?? -1) ? b : a), null);
    const rainTotal = rows.reduce((s, r) => s + (r.precip ?? 0), 0);
    return {
      name: cfg.weather.name,
      latitude: j.latitude,
      longitude: j.longitude,
      elevation: j.elevation,
      rows,
      summary: {
        tempMin: temps.length ? Math.min(...temps) : null,
        tempMax: temps.length ? Math.max(...temps) : null,
        popMax: pops.length ? Math.max(...pops) : null,
        popMaxAt: maxPopRow ? `${maxPopRow.date} ${maxPopRow.time}` : null,
        rainTotal: Number(rainTotal.toFixed(1)),
        sunrise: j.daily?.sunrise?.[0]?.slice(11, 16),
        sunset: j.daily?.sunset?.[0]?.slice(11, 16),
        conditions: [...new Set(rows.map((r) => WMO[r.code] ?? `code${r.code}`))],
      },
    };
  });
}

export function describeWeatherCode(code) {
  return WMO[code] ?? `未知(${code})`;
}

// ---------------------------------------------------------------- 余额

function readKeyFromBashrc(name) {
  try {
    const text = readFileSync(join(homedir(), '.bashrc'), 'utf-8');
    const m = text.match(new RegExp(`(?:export\\s+)?${name}=("?)([^"\\n]+)\\1`));
    return m?.[2];
  } catch {
    return undefined;
  }
}

export async function collectBalance(cfg, failures) {
  if (cfg.balance?.enabled === false) return null;
  return guard('balance', failures, async () => {
    const keyEnv = cfg.balance?.keyEnv ?? 'DEEPSEEK_API_KEY';
    const key = process.env[keyEnv] || readKeyFromBashrc(keyEnv);
    if (!key) throw new Error(`未找到 ${keyEnv}`);
    const j = await getJSON('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}` },
    });
    const info = (j.balance_infos ?? []).find((b) => b.currency === 'CNY') ?? j.balance_infos?.[0];
    return {
      label: cfg.balance?.label ?? 'DeepSeek',
      available: j.is_available,
      currency: info?.currency,
      total: info?.total_balance,
      toppedUp: info?.topped_up_balance,
      granted: info?.granted_balance,
    };
  });
}

// ---------------------------------------------------------------- 论文

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseArxiv(xml) {
  return xml
    .split('<entry>')
    .slice(1)
    .map((e) => {
      const pick = (re) => (e.match(re) ?? [])[1];
      const clean = (s) => decodeEntities(String(s ?? '').replace(/\s+/g, ' ').trim());
      return {
        id: clean(pick(/<id>([^<]+)<\/id>/)),
        title: clean(pick(/<title>([\s\S]*?)<\/title>/)),
        summary: clean(pick(/<summary>([\s\S]*?)<\/summary>/)),
        published: pick(/<published>([^<]+)<\/published>/),
        updated: pick(/<updated>([^<]+)<\/updated>/),
        primary: pick(/<arxiv:primary_category[^>]*term="([^"]+)"/),
        authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => clean(m[1])).slice(0, 4),
        categories: [...new Set([...e.matchAll(/term="([^"]+)"/g)].map((m) => m[1]))],
      };
    });
}

/** arXiv id / URL → 纯 id（去掉版本号），便于跨数据源对齐 */
function arxivId(s) {
  return String(s ?? '').match(/(\d{4}\.\d{4,5})(v\d+)?/)?.[1] ?? null;
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/** 从 HF daily_papers 取近 N 天的社区点赞数，得到「社区热度」 */
async function collectHfDaily(cfg, failures) {
  const hfCfg = cfg.papers?.hfDailyPapers;
  if (hfCfg?.enabled === false) return { items: [], upvotes: new Map(), days: 0 };
  const base = hfCfg?.base ?? 'https://hf-mirror.com';
  const days = Number(hfCfg?.days ?? 7);
  const raw = [];
  let okDays = 0;
  const errors = [];
  for (let i = 0; i < days; i += 1) {
    const day = isoDay(Date.now() - i * 86400_000);
    try {
      const j = await getJSON(`${base}/api/daily_papers?date=${day}`, { timeoutMs: 20000 });
      if (Array.isArray(j)) {
        okDays += 1;
        for (const it of j) raw.push({ ...it, day });
      }
    } catch (err) {
      errors.push(`${day}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (i + 1 < days) await sleep(150);
  }
  if (okDays === 0 && errors.length) failures.push(`hfDailyPapers: ${errors[0]}`);

  const byId = new Map();
  const items = [];
  for (const it of raw) {
    const id = arxivId(it.paper?.id ?? it.id);
    const upvotes = it.paper?.upvotes ?? 0;
    const rec = {
      id,
      title: it.paper?.title ?? it.title,
      upvotes,
      publishedAt: it.publishedAt ?? it.paper?.publishedAt,
      summary: String(it.paper?.summary ?? '').replace(/\s+/g, ' ').trim(),
      url: id ? `https://arxiv.org/abs/${id}` : undefined,
    };
    items.push(rec);
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (prev.upvotes ?? 0) < upvotes) byId.set(id, rec);
  }
  const top = Number(hfCfg?.top ?? 8);
  return { items: items.sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0)).slice(0, top), upvotes: byId, days };
}

/** 用 OpenAlex 按 DOI 批量查被引数（免费、无需 key），作为「学术热度」 */
async function collectCitations(cfg, ids, failures) {
  const out = new Map();
  const opts = cfg.papers?.heat?.openalex;
  if (opts?.enabled === false || !ids.length) return out;
  const mailto = opts?.mailto ?? cfg.contactEmail ?? 'noreply@example.com';
  const chunk = 40;
  try {
    for (let i = 0; i < ids.length; i += chunk) {
      const group = ids.slice(i, i + chunk);
      // 注意：OpenAlex 的 filter 不能整体 URL 编码（%2F/%3A 会被判 400）；OR 的写法是
      // `doi:A|B|C`（只有第一个值带键名，每个都带会 400）。
      const filter = `doi:${group.map((id) => `10.48550/arxiv.${id}`).join('|')}`;
      const url =
        `https://api.openalex.org/works?filter=${filter}` +
        `&per-page=${group.length}&select=doi,cited_by_count&mailto=${encodeURIComponent(mailto)}`;
      const j = await getJSON(url, { timeoutMs: 20000 });
      for (const w of j.results ?? []) {
        const id = arxivId(w.doi);
        if (id) out.set(id, w.cited_by_count ?? 0);
      }
      if (i + chunk < ids.length) await sleep(300);
    }
  } catch (err) {
    failures.push(`openalex: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

export async function collectPapers(cfg, failures) {
  const pCfg = cfg.papers ?? {};
  const latestHours = Number(pCfg.latestHours ?? pCfg.hours ?? 24);
  const hotDays = Number(pCfg.hotDays ?? 7);
  const maxResults = Number(pCfg.maxResults ?? 300);
  const latestPerTopic = Number(pCfg.latestPerTopic ?? pCfg.maxPerTopic ?? 6);
  const hotPerTopic = Number(pCfg.hotPerTopic ?? 6);
  const hotMinScore = Number(pCfg.hotMinScore ?? 1);
  const upWeight = Number(pCfg.heat?.upvoteWeight ?? 5);

  // 1) HF 社区热度（同时给「HF 热榜」板块用）
  const hfDaily = await collectHfDaily(cfg, failures);

  // 2) arXiv：一次查「最热窗口」的提交，再在本地切出「最新 24h」和「最热」
  const pad = 86400_000; // 服务端时间按 arXiv 自己的时区，留一天缓冲，本地再精确过滤
  const from = new Date(Date.now() - hotDays * 86400_000 - pad);
  const stamp = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}0000`;
  const range = `${stamp(from)}+TO+${stamp(new Date())}`;

  const rawTopics = [];
  const allIds = new Set();
  for (const topic of pCfg.arxiv ?? []) {
    const items = await guard(`arxiv:${topic.label}`, failures, async () => {
      const url =
        `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(topic.query)}` +
        `+AND+submittedDate:%5B${range}%5D` +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
      return parseArxiv(await getTextRetry(url, { attempts: Number(pCfg.retries ?? 3) }));
    });
    const parsed = (items ?? []).map((p) => {
      const id = arxivId(p.id);
      if (id) allIds.add(id);
      const submittedAt = p.published ?? p.updated;
      return { ...p, id: id ?? p.id, arxivId: id, submittedAt, updatedAt: p.updated ?? p.published };
    });
    rawTopics.push({ label: topic.label, query: topic.query, items: parsed });
    await sleep(Number(pCfg.topicGapMs ?? 3200)); // 别把 arXiv 打限流
  }

  // 3) 被引数（学术热度）
  const citations = await collectCitations(cfg, [...allIds], failures);

  // 4) 汇总成 latest / hot 两个榜单
  const now = Date.now();
  const sinceLatest = now - latestHours * 3600_000;
  const sinceHot = now - hotDays * 86400_000;
  const topics = rawTopics.map((t) => {
    const enriched = t.items.map((p) => {
      const upvotes = hfDaily.upvotes.get(p.arxivId)?.upvotes ?? 0;
      const cited = citations.get(p.arxivId) ?? 0;
      return { ...p, heat: { upvotes, citations: cited, score: upvotes * upWeight + cited } };
    });
    const latest = enriched
      .filter((p) => new Date(p.submittedAt ?? 0).getTime() >= sinceLatest)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
      .slice(0, latestPerTopic);
    const ranked = enriched
      .filter((p) => new Date(p.submittedAt ?? 0).getTime() >= sinceHot)
      .sort(
        (a, b) =>
          b.heat.score - a.heat.score ||
          new Date(b.submittedAt) - new Date(a.submittedAt),
      );
    const hot = ranked.filter((p) => p.heat.score >= hotMinScore).slice(0, hotPerTopic);
    return { label: t.label, query: t.query, total: enriched.length, items: latest, hot };
  });

  return {
    hours: latestHours,
    latestHours,
    hotDays,
    heatLegend: `热度 = HF 每日论文点赞 ×${upWeight} + OpenAlex 被引次数`,
    topics,
    hf: hfDaily.items,
    hfDays: hfDaily.days,
  };
}
// ---------------------------------------------------------------- Infra 动态

export async function collectInfra(cfg, failures) {
  const hours = Number(cfg.infra?.hours ?? 48);
  const since = Date.now() - hours * 3600_000;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };

  const releases = [];
  for (const repo of cfg.infra?.releases ?? []) {
    const found = await guard(`release:${repo}`, failures, async () => {
      const list = await getJSON(`https://api.github.com/repos/${repo}/releases?per_page=5`, { headers });
      return list
        .filter((r) => new Date(r.published_at ?? r.created_at).getTime() >= since)
        .map((r) => ({
          repo,
          tag: r.tag_name,
          name: r.name,
          publishedAt: r.published_at,
          prerelease: r.prerelease,
          url: r.html_url,
          notes: String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 400),
        }));
    });
    if (found?.length) releases.push(...found);
  }

  let trending = [];
  const tr = cfg.infra?.trending;
  if (tr?.enabled) {
    trending = (await guard('trending', failures, async () => {
      const days = Number(tr.days ?? 7);
      const sinceDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const q = encodeURIComponent(`llm OR vlm OR inference OR quantization in:name,description,topics created:>${sinceDate} stars:>${tr.minStars ?? 150}`);
      const j = await getJSON(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${tr.top ?? 5}`, { headers });
      return (j.items ?? []).map((r) => ({
        full_name: r.full_name,
        stars: r.stargazers_count,
        description: r.description,
        url: r.html_url,
        pushedAt: r.pushed_at,
      }));
    })) ?? [];
  }

  return { hours, releases, trending };
}

// ---------------------------------------------------------------- 项目进展

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function collectLocalRepo(repo, hours) {
  const { path } = repo;
  if (!existsSync(join(path, '.git'))) return { name: repo.name, path, error: '不是 git 仓库' };
  const since = `${hours} hours ago`;
  const name = repo.name ?? path.split('/').pop();
  try {
    const commits = git(
      ['log', `--since=${since}`, '--pretty=%h\t%ad\t%an\t%s', '--date=format:%m-%d %H:%M', '-30'],
      path,
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, author, ...rest] = line.split('\t');
        return { hash, date, author, subject: rest.join('\t') };
      });
    const dirty = git(['status', '--porcelain'], path).split('\n').filter(Boolean);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
    let remote;
    try {
      remote = git(['remote', 'get-url', 'origin'], path);
    } catch {
      remote = undefined;
    }
    const lastCommit = git(['log', '-1', '--pretty=%h %ad %s', '--date=format:%Y-%m-%d %H:%M'], path)
      .split('\n')
      .filter(Boolean)[0];
    return { name, path, branch, remote, commits, dirtyCount: dirty.length, dirtySample: dirty.slice(0, 5), lastCommit };
  } catch (err) {
    return { name, path, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectProjects(cfg, failures) {
  const hours = Number(cfg.projects?.hours ?? 48);
  const since = Date.now() - hours * 3600_000;
  const local = (cfg.projects?.local ?? []).map((r) => collectLocalRepo(r, hours));

  let github = [];
  const gh = cfg.projects?.github;
  if (gh?.enabled && gh.user) {
    github = (await guard('githubActivity', failures, async () => {
      const headers = {
        accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      };
      const events = await getJSON(`https://api.github.com/users/${gh.user}/events/public?per_page=50`, { headers });
      const byRepo = new Map();
      for (const ev of events) {
        if (ev.type !== 'PushEvent') continue;
        if (new Date(ev.created_at).getTime() < since) continue;
        const repo = ev.repo?.name;
        const entry = byRepo.get(repo) ?? { repo, url: `https://github.com/${repo}`, commits: [] };
        for (const c of ev.payload?.commits ?? []) {
          entry.commits.push({ sha: String(c.sha ?? '').slice(0, 7), message: c.message });
        }
        byRepo.set(repo, entry);
      }
      // 被本地仓库覆盖的远端条目不再重复列出
      const localNames = new Set(local.map((l) => l.name));
      return [...byRepo.values()]
        .filter((e) => !localNames.has(e.repo.split('/').pop()))
        .map((e) => ({ ...e, commits: e.commits.slice(0, 6) }));
    })) ?? [];
  }

  return { hours, local, github };
}
