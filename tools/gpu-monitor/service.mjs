#!/usr/bin/env node
/**
 * GPU 占用监控服务
 *
 * - 每 30 秒采样一次 nvidia-smi（8 卡矩阵）
 * - 空闲卡判定：单卡 util < 5% 且 显存 < 5GB，连续 3 分钟 → 飞书群 webhook 提醒
 * - 历史数据按天写入 data/samples-YYYY-MM-DD.jsonl
 * - 内置 HTTP API + 浏览器表盘（默认 :8808）
 *
 * 用法：
 *   node service.mjs            # 常驻运行（采样 + 提醒 + API）
 *   node service.mjs --once     # 只采样一次并输出 JSON
 *   node service.mjs --test-notify  # 发送一条测试 webhook 消息
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, 'config.json');
  const examplePath = join(__dirname, 'config.example.json');
  const raw = existsSync(configPath)
    ? readFileSync(configPath, 'utf-8')
    : readFileSync(examplePath, 'utf-8');
  const cfg = JSON.parse(raw);
  cfg.dataDir = join(__dirname, cfg.dataDir ?? 'data');
  cfg.stateFile = join(__dirname, cfg.stateFile ?? 'data/state.json');
  if (!cfg.webhookUrl || !cfg.webhookUrl.includes('/hook/')) {
    throw new Error('webhookUrl 未配置或无效，请编辑 config.json');
  }
  return cfg;
}

const config = loadConfig();
if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

const startedAt = Date.now();
let lastSample = null;
let lastError = null;
let freeTrack = new Map();

function localDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sampleFilePath(ts) {
  return join(config.dataDir, `samples-${localDateStr(ts)}.jsonl`);
}

function hhmmss(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function fmtGb(miB) {
  return (miB / 1024).toFixed(1);
}

async function sampleGpus() {
  const { stdout } = await execFileAsync('nvidia-smi', [
    '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [i, util, memUsed, memTotal, temp] = line
        .split(',')
        .map((s) => s.trim());
      return {
        i: Number(i),
        util: Number(util),
        memUsedMiB: Number(memUsed),
        memTotalMiB: Number(memTotal),
        temp: Number(temp),
      };
    });
}

function isFree(gpu) {
  const t = config.freeThreshold;
  return gpu.util < t.util && gpu.memUsedMiB < t.memGb * 1024;
}

async function sendWebhook(text) {
  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  });
  const data = await res.json();
  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(`webhook error: ${JSON.stringify(data)}`);
  }
}

async function sendFreeAlert(gpus, ts) {
  const t = config.freeThreshold;
  const minutes = Math.round((t.consecutiveSamples * config.intervalMs) / 60000);
  const lines = gpus.map(
    (g) =>
      `• GPU ${g.i}：util ${g.util}% | 显存 ${fmtGb(g.memUsedMiB)}GB / ${fmtGb(g.memTotalMiB)}GB | ${g.temp}°C`,
  );
  const text =
    `🆓 空闲卡提醒 ${hhmmss(ts)}\n` +
    `以下 GPU 已连续空闲约 ${minutes} 分钟，可以用了：\n` +
    lines.join('\n');
  await sendWebhook(text);
  console.log(`[gpu-monitor] sent free alert: GPU ${gpus.map((g) => g.i).join(',')}`);
}

async function sendRecoverAlert(gpus, ts) {
  const lines = gpus.map((g) => `• GPU ${g.i}：util ${g.util}% | 显存 ${fmtGb(g.memUsedMiB)}GB`);
  const text =
    `🔴 占用恢复 ${hhmmss(ts)}\n以下 GPU 已不再空闲：\n` + lines.join('\n');
  await sendWebhook(text);
  console.log(`[gpu-monitor] sent recover alert: GPU ${gpus.map((g) => g.i).join(',')}`);
}

function persistState() {
  try {
    writeFileSync(
      config.stateFile,
      JSON.stringify(Object.fromEntries(freeTrack), null, 2),
    );
  } catch (err) {
    console.error('[gpu-monitor] persist state failed:', err);
  }
}

function loadState() {
  try {
    if (!existsSync(config.stateFile)) return;
    const raw = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && /^\d+$/.test(k)) {
        freeTrack.set(Number(k), v);
      }
    }
  } catch {
    // ignore broken state
  }
}

async function tick() {
  const ts = Date.now();
  try {
    const gpus = await sampleGpus();
    lastSample = { ts, gpus };
    lastError = null;

    appendFileSync(
      sampleFilePath(ts),
      JSON.stringify({ ts, gpus }) + '\n',
      'utf-8',
    );

    // 空闲卡状态机：连续满足条件才通知；通知后需变忙再空闲才能再次通知
    const newlyFree = [];
    const recovered = [];
    for (const g of gpus) {
      const st = freeTrack.get(g.i) ?? { consecutive: 0, notified: false };
      if (isFree(g)) {
        st.consecutive += 1;
        if (
          st.consecutive >= config.freeThreshold.consecutiveSamples &&
          !st.notified
        ) {
          st.notified = true;
          newlyFree.push(g);
        }
      } else {
        if (st.notified && config.freeThreshold.notifyRecovered) {
          recovered.push(g);
        }
        st.consecutive = 0;
        st.notified = false;
      }
      freeTrack.set(g.i, st);
    }

    if (newlyFree.length > 0) {
      await sendFreeAlert(newlyFree, ts);
    }
    if (recovered.length > 0) {
      await sendRecoverAlert(recovered, ts);
    }
    persistState();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[gpu-monitor] ${new Date(ts).toISOString()} ${lastError}`);
  }
}

// ---------- HTTP API + 静态表盘 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function latestPayload() {
  const freeNow = lastSample
    ? lastSample.gpus.filter(isFree).map((g) => g.i)
    : [];
  const gpus = lastSample
    ? lastSample.gpus.map((g) => ({
        ...g,
        free: isFree(g),
        freeSamples: freeTrack.get(g.i)?.consecutive ?? 0,
        notified: freeTrack.get(g.i)?.notified ?? false,
      }))
    : [];
  return {
    ts: lastSample?.ts ?? null,
    freeNow,
    gpus,
  };
}

function readHistory(startTs) {
  const files = readdirSync(config.dataDir)
    .filter((f) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => {
      const date = f.slice(8, 18);
      return date >= localDateStr(startTs) && date <= localDateStr(Date.now());
    });

  const samples = [];
  for (const f of files) {
    const lines = readFileSync(join(config.dataDir, f), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        if (s.ts >= startTs) samples.push(s);
      } catch {
        // skip broken line
      }
    }
  }

  // 按分钟降采样
  const buckets = new Map();
  for (const s of samples) {
    const key = Math.floor(s.ts / 60000);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const gpuCount = 8;
  const points = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(key);
    const util = new Array(gpuCount).fill(0);
    const mem = new Array(gpuCount).fill(0);
    const temp = new Array(gpuCount).fill(0);
    const counts = new Array(gpuCount).fill(0);
    for (const s of group) {
      for (const g of s.gpus ?? []) {
        const idx = g.i;
        if (idx >= 0 && idx < gpuCount) {
          util[idx] += g.util ?? 0;
          mem[idx] += g.memUsedMiB ?? 0;
          temp[idx] += g.temp ?? 0;
          counts[idx] += 1;
        }
      }
    }
    for (let idx = 0; idx < gpuCount; idx += 1) {
      if (counts[idx] > 0) {
        util[idx] = Math.round(util[idx] / counts[idx]);
        mem[idx] = Math.round(mem[idx] / counts[idx]);
        temp[idx] = Math.round(temp[idx] / counts[idx]);
      }
    }
    points.push({ ts: key * 60000, util, mem, temp });
  }
  return points;
}

function serveStatic(res, urlPath) {
  const allowed = new Set(['/', '/index.html', '/chart.umd.min.js']);
  const name = urlPath === '/' ? '/index.html' : urlPath;
  if (!allowed.has(name)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const filePath = join(__dirname, 'public', name.slice(1));
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

function createApiServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          lastSampleAt: lastSample?.ts ?? null,
          lastError,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latestPayload()));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const minutes = Math.min(
        Number(url.searchParams.get('minutes') ?? 60),
        24 * 60,
      );
      const startTs = Date.now() - minutes * 60_000;
      const points = readHistory(startTs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rangeMinutes: minutes, points }));
      return;
    }

    if (req.method === 'GET') {
      serveStatic(res, url.pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  });
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--once')) {
    const gpus = await sampleGpus();
    console.log(JSON.stringify({ ts: Date.now(), gpus }, null, 2));
    return;
  }

  if (args.includes('--test-notify')) {
    await sendWebhook(
      `🧪 GPU 监控测试消息 ${hhmmss(Date.now())}\n服务已启动，空闲卡提醒功能就绪。`,
    );
    console.log('test webhook sent');
    return;
  }

  loadState();
  const server = createApiServer();
  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `🚀 GPU monitor started: sample every ${config.intervalMs}ms, dashboard http://${config.server.host}:${config.server.port}`,
    );
  });

  await tick();
  setInterval(() => void tick(), config.intervalMs);
}

main().catch((err) => {
  console.error('[gpu-monitor] fatal:', err);
  process.exit(1);
});
