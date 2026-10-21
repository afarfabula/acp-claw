#!/usr/bin/env node
/**
 * GPU 占用监控服务
 *
 * - 每 30 秒采样一次 nvidia-smi（8 卡矩阵）
 * - 空闲卡判定：单卡 util < 5% 且 显存 < 5GB
 * - 空闲提醒（按「台数」而不是按单卡）：同时空闲的卡 ≥ freeThreshold.minFreeCards
 *   （默认 4 张）且连续保持 freeThreshold.consecutiveSamples 次采样
 *   （默认 40 次 × 30s = 20 分钟）→ 飞书 webhook 提醒这几张卡可以用
 * - 占用提醒：发过空闲提醒之后，空闲卡数掉到 minFreeCards 以下并连续保持
 *   freeThreshold.recoverConsecutiveSamples 次采样（默认同 20 分钟）→ 再发一条
 *   「占用提醒」，附带当前被占用卡的用户名 + 进程命令行
 * - 历史数据按天写入 data/samples-YYYY-MM-DD.jsonl
 * - 内置 HTTP API + 浏览器表盘（默认 :8808）
 *
 * 用法：
 *   node service.mjs            # 常驻运行（采样 + 提醒 + API）
 *   node service.mjs --once     # 只采样一次并输出 JSON
 *   node service.mjs --test-notify  # 发送一条测试 webhook 消息
 *   node service.mjs --owners   # 打印当前各卡的占用者（不发送消息）
 *   node service.mjs --state    # 打印当前空闲/提醒状态机（不发送消息）
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

import { createGroupState, stepGroup } from './alert-state.mjs';

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
  cfg.freeThreshold = {
    util: 5,
    memGb: 5,
    minFreeCards: 4,
    consecutiveSamples: 40,
    notifyRecovered: true,
    ...(cfg.freeThreshold ?? {}),
  };
  if (cfg.freeThreshold.recoverConsecutiveSamples == null) {
    cfg.freeThreshold.recoverConsecutiveSamples =
      cfg.freeThreshold.consecutiveSamples;
  }
  cfg.freeThreshold.minFreeCards = Math.max(
    1,
    Math.floor(cfg.freeThreshold.minFreeCards),
  );
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

// 每张卡的连续状态（供表盘展示）
let cardTrack = new Map();
// 全局状态机：以「同时空闲的卡数」为判据（见 alert-state.mjs）
let groupState = createGroupState();

function minutesOf(samples) {
  return Math.round((samples * config.intervalMs) / 60000);
}

function loadUidToUser() {
  const map = new Map();
  try {
    for (const line of readFileSync('/etc/passwd', 'utf-8').split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
        map.set(parts[2], parts[0]);
      }
    }
  } catch {
    // passwd 不可读时退回 uid 显示
  }
  return map;
}

const uidToUser = loadUidToUser();

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

function procUser(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = status.match(/^Uid:\s*(\d+)/m);
    if (m) return uidToUser.get(m[1]) ?? `uid${m[1]}`;
  } catch {
    // 进程可能已退出或不可读
  }
  return 'unknown';
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
      .split('\0')
      .filter(Boolean)
      .join(' ');
  } catch {
    return '';
  }
}

async function describeGpuOwners(gpuIndexes) {
  const owners = new Map();
  if (gpuIndexes.length === 0) return owners;
  try {
    const [gpuOut, appOut] = await Promise.all([
      execFileAsync('nvidia-smi', [
        '--query-gpu=index,uuid',
        '--format=csv,noheader,nounits',
      ]),
      execFileAsync('nvidia-smi', [
        '--query-compute-apps=gpu_uuid,pid,used_memory,process_name',
        '--format=csv,noheader,nounits',
      ]),
    ]);
    const idxByUuid = new Map();
    for (const line of gpuOut.stdout.trim().split('\n').filter(Boolean)) {
      const [i, uuid] = line.split(',').map((s) => s.trim());
      idxByUuid.set(uuid, Number(i));
    }
    const want = new Set(gpuIndexes);
    for (const line of appOut.stdout.trim().split('\n').filter(Boolean)) {
      const [uuid, pid, mem, name] = line.split(',').map((s) => s.trim());
      const idx = idxByUuid.get(uuid);
      if (idx === undefined || !want.has(idx)) continue;
      const user = procUser(pid);
      const cmd = procCmdline(pid) || name;
      if (!owners.has(idx)) owners.set(idx, []);
      owners.get(idx).push({ user, cmd, memMiB: Number(mem) || 0 });
    }
  } catch (err) {
    console.error(`[gpu-monitor] describe owners failed: ${err}`);
  }
  return owners;
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

function gpuLine(g) {
  return `• GPU ${g.i}：util ${g.util}% | 显存 ${fmtGb(g.memUsedMiB)}GB / ${fmtGb(g.memTotalMiB)}GB | ${g.temp}°C`;
}

async function sendFreeAlert(freeGpus, ts) {
  const t = config.freeThreshold;
  const minutes = minutesOf(t.consecutiveSamples);
  const text =
    `🆓 空闲卡提醒 ${hhmmss(ts)}\n` +
    `当前有 ${freeGpus.length} 张卡已连续空闲约 ${minutes} 分钟（触发条件：≥${t.minFreeCards} 张空闲 / ${minutes} 分钟），可以用了：\n` +
    freeGpus.map(gpuLine).join('\n');
  await sendWebhook(text);
  console.log(
    `[gpu-monitor] sent free alert: ${freeGpus.length} free -> GPU ${freeGpus.map((g) => g.i).join(',')}`,
  );
}

async function sendRecoverAlert(busyGpus, freeCount, ts) {
  const t = config.freeThreshold;
  const minutes = minutesOf(t.recoverConsecutiveSamples);
  const owners = await describeGpuOwners(busyGpus.map((g) => g.i));
  const lines = [];
  for (const g of busyGpus) {
    lines.push(gpuLine(g));
    const byUser = new Map();
    for (const p of owners.get(g.i) ?? []) {
      if (!byUser.has(p.user)) byUser.set(p.user, []);
      byUser.get(p.user).push(p);
    }
    if (byUser.size === 0) {
      lines.push('  👤 未能识别占用者');
    }
    for (const [user, procs] of byUser) {
      const count = procs.length > 1 ? `（${procs.length} 个进程）` : '';
      const cmd = (procs[0]?.cmd ?? '').trim();
      const shown = cmd.length > 150 ? `${cmd.slice(0, 150)}…` : cmd;
      lines.push(`  👤 ${user}${count}: ${shown}`);
    }
  }
  const text =
    `🔴 占用提醒 ${hhmmss(ts)}\n` +
    `空闲卡已不足 ${t.minFreeCards} 张（当前 ${freeCount} 张）并持续约 ${minutes} 分钟。被占用的卡与占用者：\n` +
    (lines.length > 0 ? lines.join('\n') : '（采样异常，未能读到卡状态）');
  await sendWebhook(text);
  console.log(
    `[gpu-monitor] sent recover alert: ${freeCount} free, busy GPU ${busyGpus.map((g) => g.i).join(',')}`,
  );
}

function persistState() {
  try {
    writeFileSync(
      config.stateFile,
      JSON.stringify(
        {
          version: 2,
          savedAt: new Date().toISOString(),
          group: groupState,
          cards: Object.fromEntries(cardTrack),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('[gpu-monitor] persist state failed:', err);
  }
}

function loadState() {
  try {
    if (!existsSync(config.stateFile)) return;
    const raw = JSON.parse(readFileSync(config.stateFile, 'utf-8'));
    if (raw?.version !== 2) {
      console.log('[gpu-monitor] 旧版 state.json（按单卡计数）已忽略，重新累计');
      return;
    }
    for (const [k, v] of Object.entries(raw.cards ?? {})) {
      if (/^\d+$/.test(k)) cardTrack.set(Number(k), v);
    }
    if (raw.group) {
      groupState = {
        ...groupState,
        ...raw.group,
        freeConsecutive: Math.min(
          raw.group.freeConsecutive ?? 0,
          config.freeThreshold.consecutiveSamples,
        ),
      };
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

    const t = config.freeThreshold;
    const freeGpus = gpus.filter(isFree);
    const busyGpus = gpus.filter((g) => !isFree(g));

    // 单卡计数只为表盘展示
    for (const g of gpus) {
      const st = cardTrack.get(g.i) ?? { consecutive: 0, busyConsecutive: 0 };
      if (isFree(g)) {
        st.consecutive = (st.consecutive ?? 0) + 1;
        st.busyConsecutive = 0;
      } else {
        st.busyConsecutive = (st.busyConsecutive ?? 0) + 1;
        st.consecutive = 0;
      }
      cardTrack.set(g.i, st);
    }

    // 台数状态机：空闲/占用提醒都由它决定
    const events = stepGroup(
      groupState,
      {
        freeCount: freeGpus.length,
        minFreeCards: t.minFreeCards,
        consecutiveSamples: t.consecutiveSamples,
        recoverConsecutiveSamples: t.recoverConsecutiveSamples,
        notifyRecovered: t.notifyRecovered,
      },
      ts,
    );

    if (events.freeAlert) await sendFreeAlert(freeGpus, ts);
    if (events.recoverAlert) {
      await sendRecoverAlert(busyGpus, freeGpus.length, ts);
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
  const t = config.freeThreshold;
  const freeNow = lastSample
    ? lastSample.gpus.filter(isFree).map((g) => g.i)
    : [];
  const gpus = lastSample
    ? lastSample.gpus.map((g) => ({
        ...g,
        free: isFree(g),
        freeSamples: cardTrack.get(g.i)?.consecutive ?? 0,
        busySamples: cardTrack.get(g.i)?.busyConsecutive ?? 0,
      }))
    : [];
  return {
    ts: lastSample?.ts ?? null,
    freeNow,
    freeCount: freeNow.length,
    minFreeCards: t.minFreeCards,
    thresholds: {
      freeMinutes: minutesOf(t.consecutiveSamples),
      recoverMinutes: minutesOf(t.recoverConsecutiveSamples),
      consecutiveSamples: t.consecutiveSamples,
      recoverConsecutiveSamples: t.recoverConsecutiveSamples,
    },
    group: {
      freeConsecutive: groupState.freeConsecutive,
      busyConsecutive: groupState.busyConsecutive,
      notified: groupState.notified,
    },
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
    const t = config.freeThreshold;
    await sendWebhook(
      `🧪 GPU 监控测试消息 ${hhmmss(Date.now())}\n` +
        `当前规则：≥${t.minFreeCards} 张卡同时空闲并连续 ${minutesOf(t.consecutiveSamples)} 分钟 → 空闲提醒；` +
        `空闲卡不足 ${t.minFreeCards} 张并连续 ${minutesOf(t.recoverConsecutiveSamples)} 分钟 → 占用提醒（附占用者）。`,
    );
    console.log('test webhook sent');
    return;
  }

  if (args.includes('--owners')) {
    const gpus = await sampleGpus();
    const busy = gpus.filter((g) => !isFree(g));
    const owners = await describeGpuOwners(busy.map((g) => g.i));
    for (const g of busy) {
      console.log(`GPU ${g.i}: util=${g.util}% mem=${fmtGb(g.memUsedMiB)}GB`);
      for (const p of owners.get(g.i) ?? []) {
        const cmd = p.cmd.length > 160 ? `${p.cmd.slice(0, 160)}…` : p.cmd;
        console.log(`  ${p.user}: ${cmd}`);
      }
    }
    return;
  }

  if (args.includes('--state')) {
    loadState();
    const gpus = await sampleGpus();
    const freeGpus = gpus.filter(isFree);
    const t = config.freeThreshold;
    console.log(
      JSON.stringify(
        {
          now: new Date().toISOString(),
          freeCount: freeGpus.length,
          freeGpus: freeGpus.map((g) => g.i),
          minFreeCards: t.minFreeCards,
          rules: {
            freeAlert: `≥${t.minFreeCards} 张空闲连续 ${minutesOf(t.consecutiveSamples)} 分钟`,
            recoverAlert: `<${t.minFreeCards} 张空闲连续 ${minutesOf(t.recoverConsecutiveSamples)} 分钟`,
          },
          group: groupState,
          cards: Object.fromEntries(cardTrack),
        },
        null,
        2,
      ),
    );
    return;
  }

  loadState();
  const server = createApiServer();
  server.listen(config.server.port, config.server.host, () => {
    const t = config.freeThreshold;
    console.log(
      `🚀 GPU monitor started: sample every ${config.intervalMs}ms, dashboard http://${config.server.host}:${config.server.port}`,
    );
    console.log(
      `[gpu-monitor] 提醒规则：≥${t.minFreeCards} 张卡连续空闲 ${minutesOf(t.consecutiveSamples)} 分钟 → 空闲提醒；` +
        `空闲卡 <${t.minFreeCards} 张连续 ${minutesOf(t.recoverConsecutiveSamples)} 分钟 → 占用提醒`,
    );
  });

  await tick();
  setInterval(() => void tick(), config.intervalMs);
}

main().catch((err) => {
  console.error('[gpu-monitor] fatal:', err);
  process.exit(1);
});
