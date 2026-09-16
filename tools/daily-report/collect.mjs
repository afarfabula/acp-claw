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
        authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => clean(m[1])).slice(0, 4),
        categories: [...new Set([...e.matchAll(/term="([^"]+)"/g)].map((m) => m[1]))],
      };
    });
}

export async function collectPapers(cfg, failures) {
  const hours = Number(cfg.papers?.hours ?? 24);
  const since = Date.now() - hours * 3600_000;
  const topics = [];
  for (const topic of cfg.papers?.arxiv ?? []) {
    const items = await guard(`arxiv:${topic.label}`, failures, async () => {
      const q = encodeURIComponent(topic.query);
      const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=40`;
      const xml = await getText(url);
      return parseArxiv(xml)
        .filter((p) => new Date(p.updated ?? p.published).getTime() >= since)
        .slice(0, Number(cfg.papers.maxPerTopic ?? 6));
    });
    topics.push({ label: topic.label, items: items ?? [] });
  }

  let hf = [];
  const hfCfg = cfg.papers?.hfDailyPapers;
  if (hfCfg?.enabled !== false) {
    hf = (await guard('hfDailyPapers', failures, async () => {
      const j = await getJSON(`${hfCfg?.base ?? 'https://hf-mirror.com'}/api/daily_papers`);
      return j
        .map((it) => ({
          id: it.paper?.id,
          title: it.paper?.title ?? it.title,
          upvotes: it.paper?.upvotes ?? 0,
          publishedAt: it.publishedAt ?? it.paper?.publishedAt,
          summary: String(it.paper?.summary ?? '').replace(/\s+/g, ' ').trim(),
          url: it.paper?.id ? `https://arxiv.org/abs/${it.paper.id}` : undefined,
        }))
        .sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0))
        .slice(0, Number(hfCfg?.top ?? 8));
    })) ?? [];
  }

  return { hours, topics, hf };
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
