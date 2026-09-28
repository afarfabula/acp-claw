#!/usr/bin/env node
/**
 * codex-locks —— 列出 / 清理占着 Codex 会话写锁的进程
 *
 *   node cli.mjs list [--all] [--json]          列出会话写锁与持有者（默认只列被占用的）
 *   node cli.mjs free <threadId|前缀> [--yes]   释放指定会话的锁（结束持有它的进程）
 *   node cli.mjs clean [--yes] [选项]           清理「不在当前终端」的占用者（默认只预览）
 *
 * 选项：
 *   --codex-home <dir>   Codex 目录（默认 $CODEX_HOME 或 ~/.codex）
 *   --keep <tty|pid>     额外保留的终端/进程（可重复：--keep pts/15 --keep 12345）
 *   --include-servers    连后台 app-server 一起清（默认跳过——那通常是 acp-claw 机器人的会话）
 *   --idle <分钟>        只清「最后活动超过 N 分钟」的会话（默认 0，不限制）
 *   --force              不检查进程名（默认只结束 codex / node 类进程）
 *   --yes                真正执行（默认只预览）
 *   --json               输出 JSON
 *
 * 背景：Codex 用 ~/.codex/thread-writer-locks/<threadId>.lock 的文件锁（flock）保证同一个会话
 * 只有一个写者。只要持有者进程没退出——哪怕只是 Ctrl+Z 暂停、或者浏览器标签页关了但
 * code-server 里的终端还活着——`codex resume <id>` 就会报
 *   thread <id> already has an active writer
 * 让持有者退出（SIGTERM）就会释放锁；SIGSTOP / Ctrl+Z 无效。
 *
 * 注意：沙箱内 /proc 是隔离的、看不到宿主的进程，请在沙箱外（提权）运行本工具。
 */

import { readFileSync, readlinkSync } from 'node:fs';
import {
  ancestorPids,
  defaultCodexHome,
  isKillableComm,
  selectCleanTargets,
  snapshot,
} from './locks.mjs';
import { renderList, renderSkipped, renderTargets } from './render.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      addFlag(flags, key, true);
    } else {
      addFlag(flags, key, next);
      i += 1;
    }
  }
  return { positional, flags };
}

function addFlag(flags, key, value) {
  if (!(key in flags)) flags[key] = value;
  else if (Array.isArray(flags[key])) flags[key].push(value);
  else flags[key] = [flags[key], value];
}

function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function codexHomeOf(flags) {
  return typeof flags['codex-home'] === 'string'
    ? flags['codex-home']
    : defaultCodexHome();
}

/** 当前进程所在终端（pts/15）；非 tty 环境返回 null。 */
function callerTty() {
  for (const fd of [0, 1, 2]) {
    try {
      const m = readlinkSync(`/proc/self/fd/${fd}`).match(
        /^\/dev\/(pts\/\d+|tty\d+)$/,
      );
      if (m) return m[1];
    } catch {
      // 忽略
    }
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function waitForExit(pids, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter((p) => p > 1 && isAlive(p));
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    alive = alive.filter((p) => isAlive(p));
  }
  return alive;
}

/** 逐个 SIGTERM；返回 {killed, failed}。 */
function killAll(targets) {
  const killed = [];
  const failed = [];
  for (const target of targets) {
    const pid = target.holder.pid;
    if (pid <= 1) {
      failed.push({ ...target, error: '拒绝结束 pid<=1' });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(target);
    } catch (err) {
      failed.push({
        ...target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { killed, failed };
}

function targetJson(t) {
  return {
    threadId: t.threadId,
    name: t.name ?? null,
    pid: t.holder.pid,
    tty: t.holder.tty ?? null,
    source: t.holder.source ?? null,
    comm: t.holder.comm ?? null,
    ageMs: t.holder.ageMs ?? null,
    appServer: Boolean(t.holder.server),
  };
}

/** 从快照里取某个会话（支持 8 位前缀）。 */
function resolveSession(sessions, key) {
  const exact = sessions.filter((s) => s.threadId === key);
  if (exact.length > 0) return exact[0];
  const matches = sessions.filter((s) => s.threadId.startsWith(key));
  if (matches.length > 1) {
    const list = matches.map((s) => s.threadId.slice(0, 8)).join(', ');
    throw new Error(`前缀 ${key} 匹配到多个会话：${list}`);
  }
  return matches[0] ?? null;
}

/** 通用：预览 + 执行 + 复查。 */
function runRelease({ codexHome, targets, skipped, apply, label }) {
  const lines = [];
  if (targets.length === 0) {
    lines.push(`${label}：没有需要处理的进程。`);
  } else {
    lines.push(
      renderTargets(targets, {
        heading: apply ? `${label}（执行）` : `${label}（预览）`,
      }),
    );
  }
  const skippedText = renderSkipped(skipped);
  if (skippedText) lines.push('', skippedText);

  if (!apply || targets.length === 0) {
    if (targets.length > 0)
      lines.push('', '以上是预览，确认无误后加 --yes 真正执行。');
    return {
      text: lines.join('\n'),
      released: [],
      stillLocked: [],
      killed: [],
    };
  }

  const { killed, failed } = killAll(targets);
  const aliveAfter = waitForExit(killed.map((t) => t.holder.pid));
  for (const pid of aliveAfter) {
    lines.push(`⚠️ PID ${pid} 仍存活，可手动 kill -9 ${pid}`);
  }
  for (const item of failed)
    lines.push(`⚠️ PID ${item.holder.pid} 结束失败：${item.error}`);

  const after = snapshot(codexHome);
  const touched = new Set(targets.map((t) => t.threadId));
  const released = [];
  const stillLocked = [];
  for (const session of after.sessions) {
    if (!touched.has(session.threadId)) continue;
    if (session.locked)
      stillLocked.push({
        threadId: session.threadId,
        holders: session.holders.map((h) => h.pid),
      });
    else released.push(session.threadId);
  }
  lines.push('');
  lines.push(
    `已结束 ${killed.length} 个进程；释放锁 ${released.length} 个${released.length ? `：${released.map((id) => id.slice(0, 8)).join(', ')}` : ''}`,
  );
  if (stillLocked.length > 0) {
    lines.push(
      `仍有占用：${stillLocked.map((s) => `${s.threadId.slice(0, 8)}(pid ${s.holders.join('/')})`).join(', ')}`,
    );
  }
  return { text: lines.join('\n'), released, stillLocked, killed };
}

function cmdList(flags) {
  const codexHome = codexHomeOf(flags);
  const snap = snapshot(codexHome);
  const tty = callerTty();
  if (flags.json) {
    const { table, ...rest } = snap;
    process.stdout.write(
      `${JSON.stringify({ callerTty: tty, ...rest }, null, 2)}\n`,
    );
    return;
  }
  const lines = [renderList(snap, { callerTty: tty, all: Boolean(flags.all) })];
  if (snap.sessions.some((s) => s.locked)) {
    lines.push('');
    lines.push('释放单个会话：node cli.mjs free <threadId>');
    lines.push('清理不在当前终端的占用：node cli.mjs clean --yes');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdFree(flags, positional) {
  const key = positional[0];
  if (!key) throw new Error('用法：free <threadId|前缀> [--yes]');
  const codexHome = codexHomeOf(flags);
  const snap = snapshot(codexHome);
  const session = resolveSession(snap.sessions, key);

  if (!session) {
    process.stdout.write(`没有找到 ${key} 对应的锁文件（可能已经释放）。\n`);
    return;
  }
  if (!session.locked) {
    process.stdout.write(
      `${session.threadId} 没有被占用（锁文件是残留），直接 resume 即可。\n`,
    );
    return;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const force = Boolean(flags.force);
  const targets = [];
  const skipped = [];
  for (const holder of session.holders) {
    let why = null;
    if (holder.pid === process.pid) why = '当前进程';
    else if (uid != null && holder.uid != null && holder.uid !== uid)
      why = '其他用户';
    else if (!force && !isKillableComm(holder.comm))
      why = `不是 codex 进程（${holder.comm}）`;
    const entry = {
      threadId: session.threadId,
      name: session.name ?? null,
      holder,
    };
    if (why) skipped.push({ ...entry, why });
    else targets.push(entry);
  }

  const result = runRelease({
    codexHome,
    targets,
    skipped,
    apply: Boolean(flags.yes),
    label: `释放 ${session.threadId.slice(0, 8)}`,
  });
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          threadId: session.threadId,
          applied: Boolean(flags.yes),
          targets: targets.map(targetJson),
          skipped: skipped.map((s) => ({ ...targetJson(s), why: s.why })),
          released: result.released,
          stillLocked: result.stillLocked,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${result.text}\n`);
}

function cmdClean(flags) {
  const codexHome = codexHomeOf(flags);
  const snap = snapshot(codexHome);
  const tty = callerTty();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const idleMinutes = Number(flags.idle ?? 0);
  const { targets, skipped } = selectCleanTargets(snap.sessions, {
    callerTty: tty,
    keep: asList(flags.keep).map(String),
    includeServers: Boolean(flags['include-servers']),
    minIdleMs: Number.isFinite(idleMinutes)
      ? Math.max(0, idleMinutes) * 60_000
      : 0,
    uid,
    force: Boolean(flags.force),
    keepNewestTui: !flags['no-keep-newest'],
    ownPids: ancestorPids(process.pid, snap.table),
    selfPid: process.pid,
    now: snap.now,
  });

  const result = runRelease({
    codexHome,
    targets,
    skipped,
    apply: Boolean(flags.yes) && !flags['dry-run'],
    label: '清理不在当前终端的占用者',
  });
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          applied: Boolean(flags.yes) && !flags['dry-run'],
          callerTty: tty,
          targets: targets.map(targetJson),
          skipped: skipped.map((s) => ({ ...targetJson(s), why: s.why })),
          released: result.released,
          stillLocked: result.stillLocked,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const head = tty
    ? ''
    : '提示：当前不在 tty 里，无法自动识别「你的终端」，清理前请先用 list 确认。\n\n';
  process.stdout.write(`${head}${result.text}\n`);
}

const COMMANDS = {
  list: cmdList,
  free: cmdFree,
  unlock: cmdFree,
  clean: cmdClean,
};

function main() {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const header = readFileSyncHelp();
    process.stdout.write(`${header}\n`);
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler)
    throw new Error(`未知命令：${cmd}（可用：list / free / clean）`);
  const { flags, positional } = parseArgs(rest);
  handler(flags, positional);
}

function readFileSyncHelp() {
  // 直接复用文件头注释，避免两处维护
  const source = readSource().replace(/^#!.*\n/, '');
  return source
    .split('*/')[0]
    .replace(/^\/\*\*?/, '')
    .replace(/^ \* ?/gm, '')
    .trimEnd()
    .replace(/\n{3,}/g, '\n\n');
}

function readSource() {
  return readFileSync(new URL(import.meta.url), 'utf8');
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
