#!/usr/bin/env node
/**
 * sem —— Codex 会话管理器（Session Manager）
 *
 *   sem                              交互式界面（TTY）；非 TTY 时等价于 sem list
 *   sem list|ls [--all] [--json]     列出会话写锁与持有者（默认只列被占用的）
 *   sem free <threadId|前缀> [--yes] 释放指定会话的锁（结束持有它的进程）
 *   sem clean [--yes] [选项]         清理「不在当前终端」的占用者（默认只预览）
 *   sem tui                          显式进入交互式界面
 *   sem help | sem version           帮助 / 版本
 *
 * 交互式界面按键：↑↓ 或 j/k 选择 · Enter/f 释放 · c 清理 · a 显示全部 · r 刷新 · q 退出
 *
 * 选项：
 *   --codex-home <dir>   Codex 目录（默认 $CODEX_HOME 或 ~/.codex）
 *   --keep <tty|pid>     额外保留的终端/进程（可重复：--keep pts/15 --keep 12345）
 *   --include-servers    连后台 app-server 一起清（默认跳过——那通常是 acp-claw 机器人的会话）
 *   --idle <分钟>        只清「最后活动超过 N 分钟」的会话（默认 0，不限制）
 *   --no-keep-newest     不在当前终端时也保留「最近打开的会话」（默认保留）
 *   --force              不检查进程名（默认只结束 codex / node 类进程）
 *   --yes                真正执行（默认只预览）
 *   --json               输出 JSON（仅 list/free/clean）
 *   --no-color           关闭颜色（默认跟随 TTY；NO_COLOR 也生效）
 *
 * 背景：Codex 用 ~/.codex/thread-writer-locks/<threadId>.lock 的文件锁（flock）保证同一个会话
 * 只有一个写者。只要持有者进程没退出——哪怕只是 Ctrl+Z 暂停、或者浏览器标签页关了但
 * code-server 里的终端还活着——`codex resume <id>` 就会报
 *   thread <id> already has an active writer
 * 让持有者退出（SIGTERM）就会释放锁；SIGSTOP / Ctrl+Z 无效。
 *
 * 注意：沙箱内 /proc 是隔离的、看不到宿主的进程，请在沙箱外（提权）运行本工具。
 */

import { readFileSync } from 'node:fs';
import { releaseTargets } from './actions.mjs';
import {
  ancestorPids,
  callerTty,
  defaultCodexHome,
  isKillableComm,
  selectCleanTargets,
  snapshot,
} from './locks.mjs';
import { renderList, renderSkipped, renderTargets } from './render.mjs';
import { createStyle, supportsColor } from './style.mjs';

const VERSION = '0.2.0';

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

function styleOf(flags) {
  const enabled = flags['no-color'] ? false : supportsColor();
  return createStyle(enabled);
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

/** 从快照里取某个会话（支持 id 前缀）。 */
function resolveSession(sessions, key) {
  const exact = sessions.filter((s) => s.threadId === key);
  if (exact.length > 0) return exact[0];
  const matches = sessions.filter((s) => s.threadId.startsWith(key));
  if (matches.length > 1) {
    const list = matches.map((s) => s.threadId.slice(0, 13)).join(', ');
    throw new Error(
      `前缀 ${key} 匹配到多个会话：${list}（用更长的前缀或完整 id）`,
    );
  }
  return matches[0] ?? null;
}

/** 预览 / 执行 / 复查，CLI 三个命令共用。 */
function runRelease({ codexHome, targets, skipped, apply, label, style }) {
  const lines = [];
  if (targets.length === 0) {
    lines.push(`${label}：没有需要处理的进程。`);
  } else {
    lines.push(
      renderTargets(targets, {
        heading: apply ? `${label}（执行）` : `${label}（预览）`,
        style,
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

  const result = releaseTargets(codexHome, targets);
  for (const pid of result.aliveAfter)
    lines.push(`⚠️ PID ${pid} 仍存活，可手动 kill -9 ${pid}`);
  for (const item of result.failed)
    lines.push(`⚠️ PID ${item.holder.pid} 结束失败：${item.error}`);

  lines.push('');
  const released = result.released.map((id) => id.slice(0, 8)).join(', ');
  lines.push(
    `已结束 ${result.killed.length} 个进程；释放锁 ${result.released.length} 个${released ? `：${released}` : ''}`,
  );
  if (result.stillLocked.length > 0) {
    lines.push(
      `仍有占用：${result.stillLocked.map((s) => `${s.threadId.slice(0, 8)}(pid ${s.holders.join('/')})`).join(', ')}`,
    );
  }
  return { text: lines.join('\n'), ...result };
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
    return { snap, tty };
  }
  const style = styleOf(flags);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const lines = [
    renderList(snap, { callerTty: tty, all: Boolean(flags.all), style, uid }),
  ];
  if (snap.sessions.some((s) => s.locked)) {
    lines.push('');
    lines.push(
      style.gray(
        '释放单个：sem free <id> · 批量清理：sem clean --yes · 交互界面：sem',
      ),
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return { snap, tty };
}

function cmdFree(flags, positional) {
  const key = positional[0];
  if (!key) throw new Error('用法：sem free <threadId|前缀> [--yes]');
  const codexHome = codexHomeOf(flags);
  const style = styleOf(flags);
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
    label: `释放 ${session.threadId.slice(0, 13)}`,
    style,
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
  const style = styleOf(flags);
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
    style,
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
    : '提示：当前不在 tty 里，无法自动识别「你的终端」，清理前请先用 sem list 确认。\n\n';
  process.stdout.write(`${head}${result.text}\n`);
}

async function cmdTui(flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('交互界面需要 TTY；这里改为 `sem list`。\n\n');
    cmdList(flags);
    return;
  }
  const { runTui } = await import('./tui.mjs');
  await runTui({ codexHome: codexHomeOf(flags) });
}

function cmdVersion() {
  process.stdout.write(`sem ${VERSION}\ncodex home: ${defaultCodexHome()}\n`);
}

function helpText() {
  const source = readFileSync(new URL(import.meta.url), 'utf8').replace(
    /^#!.*\n/,
    '',
  );
  return source
    .split('*/')[0]
    .replace(/^\/\*\*?/, '')
    .replace(/^ \* ?/gm, '')
    .trim();
}

async function main() {
  const [cmd = '', ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  switch (cmd) {
    case '':
    case 'tui':
    case 'ui':
      return cmdTui(flags);
    case 'list':
    case 'ls':
      return cmdList(flags);
    case 'free':
    case 'unlock':
    case 'release':
      return cmdFree(flags, positional);
    case 'clean':
    case 'gc':
      return cmdClean(flags);
    case 'version':
    case '--version':
    case '-v':
      return cmdVersion();
    case 'help':
    case '--help':
    case '-h':
      return process.stdout.write(`${helpText()}\n`);
    default:
      throw new Error(
        `未知命令：${cmd}（可用：list / free / clean / tui / help）`,
      );
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
