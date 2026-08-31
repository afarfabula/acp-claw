#!/usr/bin/env node
/**
 * GPU 监控终端视图
 *
 * 用法：
 *   node dash.mjs matrix                 # 输出一次当前矩阵
 *   node dash.mjs live                   # 实时表格 + ASCII 历史曲线（每 5s 刷新）
 *   node dash.mjs summary --hours 24     # 每张卡均值/峰值/空闲占比统计
 *   node dash.mjs health                 # 服务健康检查
 *
 * 依赖 gpu-monitor 服务（service.mjs）运行中。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadServerConfig() {
  const path = join(__dirname, 'config.json');
  const example = join(__dirname, 'config.example.json');
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : readFileSync(example, 'utf-8');
  return JSON.parse(raw).server ?? { host: '127.0.0.1', port: 8808 };
}

const server = loadServerConfig();
const base = `http://${server.host}:${server.port}`;

async function api(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

function fmtGb(miB) {
  return (miB / 1024).toFixed(1);
}

function color(open, text, close = '\x1b[0m') {
  return `\x1b[${open}m${text}${close}`;
}

function utilColor(util) {
  if (util >= 95) return color('31', String(util).padStart(3));
  if (util >= 50) return color('33', String(util).padStart(3));
  return color('32', String(util).padStart(3));
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function sparkline(values, width = 40) {
  if (!values || values.length === 0) return '';
  // 均匀抽 width 个点
  const step = Math.max(1, Math.floor(values.length / width));
  const picked = [];
  for (let i = 0; i < values.length && picked.length < width; i += step) {
    picked.push(values[i]);
  }
  return picked
    .map((v) => {
      const level = Math.min(7, Math.max(0, Math.floor((v / 100) * 8)));
      return SPARK[level];
    })
    .join('');
}

function hhmmss(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function printMatrix(latest) {
  if (!latest.gpus || latest.gpus.length === 0) {
    console.log('暂无采样数据');
    return;
  }
  console.log(`采样时间: ${hhmmss(latest.ts)}  空闲卡: ${latest.freeNow.length ? latest.freeNow.join(', ') : '无'}`);
  console.log('GPU   UTIL   MEM(GB)   TEMP   STATUS');
  for (const g of latest.gpus) {
    const free = g.free ? color('32', 'FREE ') : color('90', 'busy');
    console.log(
      ` ${String(g.i).padEnd(3)} ${utilColor(g.util)}%  ${fmtGb(g.memUsedMiB).padStart(6)}/${fmtGb(g.memTotalMiB).padEnd(6)} ${String(g.temp).padStart(3)}°C  ${free}`,
    );
  }
}

async function cmdMatrix() {
  printMatrix(await api('/api/latest'));
}

async function cmdLive() {
  let lastTs = 0;
  const loop = async () => {
    try {
      const [latest, history] = await Promise.all([
        api('/api/latest'),
        api('/api/history?minutes=60'),
      ]);
      const now = Date.now();
      if (now - lastTs > 2000) {
        lastTs = now;
        process.stdout.write('\x1b[2J\x1b[H');
        printMatrix(latest);
        console.log('\n最近 60 分钟利用率曲线（每张卡）:');
        const count = latest.gpus.length;
        for (let i = 0; i < count; i += 1) {
          const util = history.points.map((p) => p.util[i] ?? 0);
          console.log(` GPU ${String(i).padEnd(2)} ${sparkline(util)}`);
        }
      }
    } catch (err) {
      process.stdout.write('\x1b[2J\x1b[H');
      console.error('连接服务失败：', err instanceof Error ? err.message : err);
      console.error('请先启动 service.mjs');
    }
  };
  await loop();
  setInterval(() => void loop(), 5000);
}

async function cmdSummary(hours) {
  const minutes = hours * 60;
  const history = await api(`/api/history?minutes=${minutes}`);
  const points = history.points;
  if (points.length === 0) {
    console.log('该时间范围内没有数据');
    return;
  }
  const count = 8;
  console.log(`统计范围: 最近 ${hours} 小时（${points.length} 个采样点，1 分钟粒度）\n`);
  console.log('GPU    AVG_UTIL  MAX_UTIL  AVG_MEM(GB)  FREE_PCT  FREE_AVG_MEM(GB)');
  for (let i = 0; i < count; i += 1) {
    let sumUtil = 0;
    let maxUtil = 0;
    let sumMem = 0;
    let freeCount = 0;
    let freeMemSum = 0;
    for (const p of points) {
      const util = p.util[i] ?? 0;
      const mem = p.mem[i] ?? 0;
      sumUtil += util;
      if (util > maxUtil) maxUtil = util;
      sumMem += mem;
      if (util < 5 && mem < 5 * 1024) {
        freeCount += 1;
        freeMemSum += mem;
      }
    }
    const n = points.length;
    const freePct = ((freeCount / n) * 100).toFixed(1);
    const avgFreeMem = freeCount > 0 ? fmtGb(freeMemSum / freeCount) : '-';
    console.log(
      ` GPU ${String(i).padEnd(2)} ${(sumUtil / n).toFixed(1).padStart(7)}%  ${String(maxUtil).padStart(7)}%  ${fmtGb(sumMem / n).padStart(9)}    ${freePct.padStart(6)}%  ${avgFreeMem.padStart(10)}`,
    );
  }
}

async function cmdHealth() {
  const health = await api('/api/health');
  console.log(
    JSON.stringify(
      {
        ...health,
        lastSampleAt: hhmmss(health.lastSampleAt),
      },
      null,
      2,
    ),
  );
}

function usage() {
  console.log(
    [
      '用法:',
      '  node dash.mjs matrix',
      '  node dash.mjs live',
      '  node dash.mjs summary --hours 24',
      '  node dash.mjs health',
    ].join('\n'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1] ?? 24) : 24;

  try {
    if (cmd === 'matrix') {
      await cmdMatrix();
    } else if (cmd === 'live') {
      await cmdLive();
    } else if (cmd === 'summary') {
      await cmdSummary(Number.isFinite(hours) && hours > 0 ? hours : 24);
    } else if (cmd === 'health') {
      await cmdHealth();
    } else {
      usage();
      process.exit(1);
    }
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
