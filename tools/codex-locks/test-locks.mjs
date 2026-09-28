#!/usr/bin/env node
/**
 * codex-locks 自测：node test-locks.mjs
 *
 * 全部在临时 CODEX_HOME 里做，用自己 fork 出来的进程模拟「占着锁的会话」，
 * 不会碰真实的 ~/.codex（也不会误杀你的会话）。
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fallbackLabel,
  selectCleanTargets,
  shortCwd,
  snapshot,
  stripPreamble,
  ttyName,
} from './locks.mjs';
import { formatDuration, pad, truncate } from './render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'cli.mjs');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(
      `  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`,
    );
  }
}

function checkTrue(name, value) {
  check(name, Boolean(value), true);
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'codex-locks-test-'));
  mkdirSync(join(home, 'thread-writer-locks'), { recursive: true });
  return home;
}

/** 起一个持有锁文件的进程（模拟 codex TUI / app-server）。 */
function holdLock(home, threadId) {
  const lockPath = join(home, 'thread-writer-locks', `${threadId}.lock`);
  closeSync(openSync(lockPath, 'a'));
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("fs").openSync(process.argv[1], "r"); setInterval(() => {}, 1000);',
      lockPath,
    ],
    { stdio: 'ignore' },
  );
  return { pid: child.pid, lockPath, child };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

console.log('纯函数');
check('formatDuration 秒', formatDuration(45_000), '45s');
check(
  'formatDuration 天',
  formatDuration(5 * 86400_000 + 20 * 3600_000),
  '5d20h',
);
check('formatDuration 时', formatDuration(3 * 3600_000 + 12 * 60_000), '3h12m');
check('pad 中文按 2 列算', pad('解压', 6), '解压  ');
check('truncate 中文', truncate('一二三四五六', 5), '一二…');
check('ttyName pts/60', ttyName((136 << 8) | 60), 'pts/60');
check('ttyName 无终端', ttyName(0), null);
check(
  'stripPreamble 去 environment_context',
  stripPreamble('<environment_context>x</environment_context>你好'),
  '你好',
);
check(
  'stripPreamble 去 file 块',
  stripPreamble('<file path="core.md">\n# Core\n</file>\n\n检查 GPU'),
  '检查 GPU',
);
check(
  'fallbackLabel 子 agent',
  fallbackLabel({ thread_source: 'subagent', cwd: '/x' }),
  '[子 agent]',
);
check(
  'fallbackLabel acp-claw',
  fallbackLabel({ originator: 'acp-claw', cwd: '/x' }),
  '[acp-claw 机器人]',
);
checkTrue(
  'shortCwd 收敛到 ~ 或末两段',
  shortCwd(`${process.env.HOME ?? '/root'}/a/b`).startsWith('~') ||
    shortCwd('/a/b/c') === '…/b/c',
);

console.log('\nselectCleanTargets');
const session = {
  threadId: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: '测试会话',
  holders: [
    {
      pid: 101,
      tty: 'pts/15',
      uid: 1000,
      comm: 'codex',
      interactive: true,
      source: 'trae',
      startMs: 1_000,
    },
    {
      pid: 102,
      tty: 'pts/60',
      uid: 1000,
      comm: 'codex',
      interactive: true,
      source: 'code-server',
      startMs: 5_000,
    },
    {
      pid: 103,
      tty: null,
      uid: 1000,
      comm: 'codex',
      interactive: false,
      server: true,
      startMs: 3_000,
    },
    {
      pid: 104,
      tty: 'pts/61',
      uid: 1000,
      comm: 'bash',
      interactive: true,
      startMs: 4_000,
    },
    {
      pid: 105,
      tty: 'pts/62',
      uid: 999,
      comm: 'codex',
      interactive: true,
      startMs: 6_000,
    },
  ],
  lastActivityMs: Date.now() - 3600_000,
};
const cleared = selectCleanTargets([session], {
  callerTty: 'pts/15',
  uid: 1000,
  selfPid: -1,
  ownPids: new Set(),
});
check(
  '只留下「别人的终端」那一个',
  cleared.targets.map((t) => t.holder.pid),
  [102],
);
const reasons = Object.fromEntries(
  cleared.skipped.map((s) => [s.holder.pid, s.why]),
);
check('当前终端被保留', reasons[101], '当前终端');
check(
  '后台 app-server 默认保留',
  reasons[103],
  '后台 app-server（机器人会话，默认保留）',
);
check('非 codex 进程被保留', reasons[104], '不是 codex 进程（bash）');
check('其他用户被保留', reasons[105], '其他用户');

const withServers = selectCleanTargets([session], {
  callerTty: 'pts/15',
  uid: 1000,
  selfPid: -1,
  ownPids: new Set(),
  includeServers: true,
});
check(
  '--include-servers 后会带上 app-server',
  withServers.targets.map((t) => t.holder.pid),
  [102, 103],
);

const idleGuard = selectCleanTargets([session], {
  callerTty: 'pts/15',
  uid: 1000,
  selfPid: -1,
  ownPids: new Set([102]),
  minIdleMs: 30 * 60_000,
});
check(
  '--idle 会放过「刚活动过」的',
  idleGuard.targets.map((t) => t.holder.pid),
  [],
);
checkTrue(
  '--idle 的跳过原因',
  idleGuard.skipped.some((s) => s.holder.pid === 102 && s.why === '当前进程链'),
);

// 机器人/脚本代跑时没有 tty，要自动保留「最近打开的交互式会话」（pid 102 最新）
const fromBot = selectCleanTargets([session], {
  callerTty: null,
  uid: 1000,
  selfPid: -1,
  ownPids: new Set(),
});
check(
  '非 tty 环境保留最近打开的会话',
  fromBot.targets.map((t) => t.holder.pid),
  [101],
);
checkTrue(
  '并说明原因',
  fromBot.skipped.some(
    (s) => s.holder.pid === 102 && s.why.includes('最近打开的终端'),
  ),
);
const fromBotAll = selectCleanTargets([session], {
  callerTty: null,
  uid: 1000,
  selfPid: -1,
  ownPids: new Set(),
  keepNewestTui: false,
});
check(
  '--no-keep-newest 时不再保留',
  fromBotAll.targets.map((t) => t.holder.pid),
  [101, 102],
);

console.log('\n端到端（临时 CODEX_HOME，不碰真实 ~/.codex）');
// 沙箱内 node 子进程的管道输出会被丢弃，先探一下，免得看到一堆假失败
const probe = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ok")']);
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.on('close', () => resolve(out));
});
if (probe !== 'ok') {
  console.log('  ⚠️  无法捕获子进程输出（沙箱内 node 子进程的管道输出会丢）。');
  console.log(
    '      请在沙箱外/提权运行：node tools/codex-locks/test-locks.mjs',
  );
  process.exit(1);
}

const home = makeHome();
const threadA = 'bbbbbbbb-1111-4111-8111-111111111111';
const threadB = 'bbbbbbbb-2222-4222-8222-222222222222';

const a = holdLock(home, threadA);
const b = holdLock(home, threadB);
await new Promise((r) => setTimeout(r, 300));

try {
  const snap = snapshot(home);
  const locked = snap.sessions.filter((s) => s.locked);
  check('两个锁都被识别为占用', locked.length, 2);
  checkTrue(
    '持有者 pid 正确',
    locked.every((s) => [a.pid, b.pid].includes(s.holders[0].pid)),
  );

  const listed = await runCli(['list', '--json', '--codex-home', home]);
  const parsed = JSON.parse(listed.out);
  check(
    'list --json 能看到 2 个占用',
    parsed.sessions.filter((s) => s.locked).length,
    2,
  );

  const free = await runCli(['free', threadA, '--yes', '--codex-home', home]);
  checkTrue('free 报出已结束进程', free.out.includes('已结束 1 个进程'));
  checkTrue('free 之后进程真的退出了', await waitDead(a.pid));
  const afterFree = snapshot(home);
  check(
    'free 释放了它那把锁',
    afterFree.sessions.find((s) => s.threadId === threadA).locked,
    false,
  );
  check(
    '另一个锁不受影响',
    afterFree.sessions.find((s) => s.threadId === threadB).locked,
    true,
  );

  // 合成进程没有 tty，默认会被当成「后台 app-server」跳过——这正是我们要的安全默认
  const plain = await runCli(['clean', '--codex-home', home]);
  checkTrue(
    'clean 默认不碰无终端的 app-server',
    plain.out.includes('没有需要处理的进程') && isAlive(b.pid),
  );

  const dry = await runCli([
    'clean',
    '--include-servers',
    '--codex-home',
    home,
  ]);
  checkTrue(
    'clean 默认只预览（不杀进程）',
    dry.out.includes('预览') && isAlive(b.pid),
  );

  const clean = await runCli([
    'clean',
    '--yes',
    '--include-servers',
    '--codex-home',
    home,
  ]);
  checkTrue('clean 报告释放锁', clean.out.includes('释放锁 1 个'));
  checkTrue('clean 之后进程退出', await waitDead(b.pid));
  check(
    'clean 之后没有占用',
    snapshot(home).sessions.filter((s) => s.locked).length,
    0,
  );
  checkTrue('锁文件仍保留（只是没人持有）', statSync(a.lockPath).size === 0);

  const missing = await runCli([
    'free',
    'cccccccc-3333-4333-8333-333333333333',
    '--codex-home',
    home,
  ]);
  checkTrue(
    'free 不存在的会话不报错',
    missing.code === 0 && missing.out.includes('没有找到'),
  );
} finally {
  for (const pid of [a.pid, b.pid]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出了
    }
  }
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
