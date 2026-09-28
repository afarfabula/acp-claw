/**
 * sem 的交互式界面：全屏列表 + 方向键选择 + 确认后释放锁。
 * 只用 ANSI + raw mode，没有额外依赖；非 TTY 环境请用 `sem list`。
 */

import { releaseTargets } from './actions.mjs';
import {
  ancestorPids,
  callerTty,
  holderBadge,
  holderKind,
  primaryHolder,
  selectCleanTargets,
  snapshot,
} from './locks.mjs';
import { displayWidth, formatDuration, pad, truncate } from './render.mjs';
import { createStyle, holderStyle } from './style.mjs';

/** 排序：被占用的在前、占得久的在前。 */
function sortRows(a, b) {
  if (a.locked !== b.locked) return a.locked ? -1 : 1;
  const ageA = a.primary?.ageMs ?? -1;
  const ageB = b.primary?.ageMs ?? -1;
  if (ageA !== ageB) return ageB - ageA;
  return a.threadId.localeCompare(b.threadId);
}

export function buildModel({ codexHome, showAll = false }) {
  const snap = snapshot(codexHome);
  const tty = callerTty();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const ownPids = ancestorPids(process.pid, snap.table);
  const rows = snap.sessions
    .filter((s) => (showAll ? true : s.locked))
    .map((session) => {
      const primary = primaryHolder(session, { uid });
      return {
        ...session,
        primary,
        kind: holderKind(primary, { tty, uid }),
        snapNow: snap.now,
      };
    })
    .sort(sortRows);
  return { snap, rows, tty, uid, ownPids };
}

function fit(line, width) {
  const fill = Math.max(0, width - displayWidth(line));
  return `${line}${' '.repeat(fill)}`;
}

function topBorder(width, left, right) {
  const head = `╭─ ${left} `;
  const tail = right ? ` ${right} ─╮` : '─╮';
  const fill = Math.max(0, width - displayWidth(head) - displayWidth(tail));
  return `${head}${'─'.repeat(fill)}${tail}`;
}

function bottomBorder(width, center) {
  const head = `╰─ ${center} `;
  const fill = Math.max(0, width - displayWidth(head) - 1);
  return `${head}${'─'.repeat(fill)}╯`;
}

const PREFIX_W = 2 + 13 + 2; // "● " + threadId(13) + "  "

/** 一行会话：宽终端带 pid/tty/来源，窄终端只留名字和时长。 */
export function rowLine(row, { width, wide, style, selected }) {
  const color = row.locked ? holderStyle(style, row.kind) : style.gray;
  const marker = row.locked ? '●' : '○';
  const holder = row.primary;
  const age = holder?.ageMs != null ? formatDuration(holder.ageMs) : '-';
  const last = row.lastActivityMs ?? row.updatedAt;
  const lastText = last ? `${formatDuration(row.snapNow - last)}前` : '-';

  const tail = wide
    ? [
        pad(holder?.pid != null ? String(holder.pid) : '-', 7),
        pad(holder?.tty ?? '—', 8),
        pad(
          truncate(holder?.source ?? (holder?.server ? 'app-server' : '-'), 12),
          12,
        ),
        pad(age, 7),
        pad(lastText, 8),
      ].join(' ')
    : pad(age, 7);
  const nameWidth = Math.max(10, width - PREFIX_W - 1 - displayWidth(tail));

  const prefix = `${color(marker)} ${style.dim(pad(row.threadId.slice(0, 13), 13))}  `;
  const name = pad(truncate(row.name ?? '(无标题)', nameWidth), nameWidth);
  const line = fit(`${prefix}${name} ${style.gray(tail)}`, width);
  return selected ? style.selected(line) : line;
}

function detailLines(row, { width, style, tty, uid }) {
  if (!row) return ['', '', ''];
  const holder = row.primary;
  const kind = holderKind(holder, { tty, uid });
  const color = holderStyle(style, kind);
  const first = style.bold(row.threadId);
  const second = holder
    ? [
        color('●'),
        `PID ${style.key(String(holder.pid))}`,
        holderBadge(holder, kind),
        holder.tty ? `tty ${holder.tty}` : '无终端',
        holder.source ?? '未知来源',
        `已占 ${formatDuration(holder.ageMs)}`,
        row.lastActivityMs
          ? `最后活动 ${formatDuration(row.snapNow - row.lastActivityMs)}前`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : style.ok('○ 空闲（只是锁文件残留，没有被占用）');
  const third = holder
    ? style.gray(
        truncate(
          [
            holder.cwd ? `cwd ${holder.cwd}` : null,
            holder.args?.length
              ? `cmd ${holder.args.slice(0, 3).join(' ')}`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
          width,
        ),
      )
    : '';
  return [truncate(first, width), second, third];
}

export async function runTui({ codexHome, refreshMs = 1500 } = {}) {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || !out.isTTY)
    throw new Error('交互界面需要 TTY（管道里请用 sem list）');

  const style = createStyle(true);
  let showAll = false;
  let cursor = 0;
  let offset = 0;
  let message = '';
  let messageStyle = style.gray;
  let confirm = null; // { text, targets, label }
  let model = buildModel({ codexHome, showAll });
  let disposed = false;
  let done = null;
  let timer = null;
  let lastFrame = null;

  const reload = () => {
    model = buildModel({ codexHome, showAll });
    if (cursor >= model.rows.length)
      cursor = Math.max(0, model.rows.length - 1);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    input.setRawMode?.(false);
    input.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };

  const quit = (code = 0) => {
    cleanup();
    if (timer) clearInterval(timer);
    out.off('resize', draw);
    input.off('data', onData);
    done?.(code);
  };

  const killTargets = (targets, label) => {
    message = `正在结束 ${targets.length} 个进程…`;
    messageStyle = style.warn;
    draw();
    const result = releaseTargets(codexHome, targets);
    const released = result.released.map((id) => id.slice(0, 8)).join(', ');
    if (result.stillLocked.length > 0) {
      message = `⚠️ ${label}：释放 ${result.released.length} 个，仍有占用 ${result.stillLocked
        .map((s) => s.threadId.slice(0, 8))
        .join(', ')}`;
      messageStyle = style.warn;
    } else {
      message = `✓ ${label}：结束 ${result.killed.length} 个进程，释放锁 ${released || '（无）'}`;
      messageStyle = style.ok;
    }
    reload();
  };

  const freeSelected = () => {
    const row = model.rows[cursor];
    if (!row?.locked) {
      message = '这一行没有被占用（○ 表示只是残留的锁文件）。';
      messageStyle = style.gray;
      return;
    }
    const targets = row.holders.map((holder) => ({
      threadId: row.threadId,
      name: row.name,
      holder,
    }));
    const flags = [];
    if (row.holders.some((h) => h.tty && h.tty === model.tty))
      flags.push('你自己所在终端');
    if (row.holders.some((h) => !h.interactive))
      flags.push('后台 app-server（机器人）');
    confirm = {
      text: `结束 ${targets.length} 个进程并释放 ${row.threadId.slice(0, 8)} 的锁${flags.length ? `（含${flags.join('、')}！）` : ''}  [y/N]`,
      targets,
      label: `已释放 ${row.threadId.slice(0, 8)}`,
    };
  };

  const cleanAll = () => {
    const { targets } = selectCleanTargets(model.snap.sessions, {
      callerTty: model.tty,
      uid: model.uid,
      ownPids: model.ownPids,
      selfPid: process.pid,
      keepNewestTui: !model.tty,
    });
    if (targets.length === 0) {
      message = '没有需要清理的进程（机器人会话和你当前终端会自动跳过）。';
      messageStyle = style.gray;
      return;
    }
    confirm = {
      text: `清理 ${targets.length} 个不在当前终端的占用者  [y/N]`,
      targets,
      label: '清理完成',
    };
  };

  function draw() {
    const width = Math.max(64, out.columns ?? 100);
    const height = Math.max(12, out.rows ?? 30);
    const inner = width - 2;
    const wide = inner >= 88;
    const held = model.snap.sessions.filter((s) => s.locked).length;
    const lines = [];

    lines.push(
      topBorder(
        width,
        `${style.bold('sem')}${style.gray(' · Codex Session Manager')}`,
        style.gray(`${model.rows.length} 项 · ${held} 占用`),
      ),
    );
    lines.push(`│${' '.repeat(inner)}│`);

    const listHeight = Math.max(3, height - 8 - (message ? 1 : 0));
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + listHeight) offset = cursor - listHeight + 1;
    const visible = model.rows.slice(offset, offset + listHeight);

    if (model.rows.length === 0) {
      const hint = showAll
        ? '没有任何锁文件'
        : '没有被占用的会话 🎉（按 a 显示空闲锁文件）';
      lines.push(`│${fit(`  ${style.gray(hint)}`, inner)}│`);
      for (let i = 1; i < listHeight; i += 1)
        lines.push(`│${' '.repeat(inner)}│`);
    } else {
      visible.forEach((row, i) => {
        const selected = offset + i === cursor;
        const text = rowLine(row, {
          width: inner - 2,
          wide,
          style,
          selected,
        });
        lines.push(`│ ${text} │`);
      });
      for (let i = visible.length; i < listHeight; i += 1)
        lines.push(`│${' '.repeat(inner)}│`);
    }

    lines.push(`│${' '.repeat(inner)}│`);
    for (const line of detailLines(model.rows[cursor], {
      width: inner - 2,
      style,
      tty: model.tty,
      uid: model.uid,
    })) {
      lines.push(`│ ${fit(line, inner - 2)} │`);
    }
    if (message) lines.push(`│ ${fit(messageStyle(message), inner - 2)} │`);

    lines.push(
      confirm
        ? bottomBorder(width, style.warn(confirm.text))
        : bottomBorder(
            width,
            style.gray(
              '↑↓/jk 选择 · Enter/f 释放 · c 清理 · a 全部 · r 刷新 · q 退出',
            ),
          ),
    );

    const frame = `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\n')}\x1b[J`;
    if (frame === lastFrame) return; // 没变化就不重绘
    lastFrame = frame;
    out.write(frame);
  }

  const handleChar = (ch) => {
    if (confirm) {
      if (ch === 'y' || ch === 'Y' || ch === '\r') {
        const { targets, label } = confirm;
        confirm = null;
        killTargets(targets, label);
      } else if (ch === 'n' || ch === 'N' || ch === 'q' || ch === '\x1b') {
        confirm = null;
        message = '已取消。';
        messageStyle = style.gray;
      }
      draw();
      return;
    }
    switch (ch) {
      case 'q':
      case '\x03':
        quit(0);
        return;
      case 'j':
        cursor = Math.min(model.rows.length - 1, cursor + 1);
        break;
      case 'k':
        cursor = Math.max(0, cursor - 1);
        break;
      case 'g':
        cursor = 0;
        break;
      case 'G':
        cursor = Math.max(0, model.rows.length - 1);
        break;
      case 'a':
        showAll = !showAll;
        reload();
        message = showAll ? '显示全部锁文件（含空闲的）' : '只显示被占用的会话';
        messageStyle = style.gray;
        break;
      case 'r':
        reload();
        message = '已刷新。';
        messageStyle = style.gray;
        break;
      case 'f':
      case '\r':
        freeSelected();
        break;
      case 'c':
        cleanAll();
        break;
      default:
        break;
    }
    draw();
  };

  const onData = (buf) => {
    const text = buf.toString('utf8');
    let i = 0;
    while (i < text.length) {
      if (text.startsWith('\x1b[A', i) || text.startsWith('\x1b[B', i)) {
        const delta = text[i + 2] === 'A' ? -1 : 1;
        cursor = Math.min(Math.max(0, model.rows.length - 1), cursor + delta);
        i += 3;
        draw();
        continue;
      }
      if (text.startsWith('\x1b[', i)) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 需要匹配 ANSI 转义序列
        const m = text.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        i += m ? m[0].length : 1;
        continue;
      }
      handleChar(text[i]);
      i += 1;
    }
  };

  out.write('\x1b[?1049h\x1b[?25l');
  input.setRawMode(true);
  input.resume();
  input.on('data', onData);
  out.on('resize', draw);
  timer = setInterval(() => {
    if (confirm) return;
    reload();
    draw();
  }, refreshMs);
  draw();

  return new Promise((resolve) => {
    done = resolve;
    process.once('SIGINT', () => quit(0));
    process.once('SIGTERM', () => quit(0));
  });
}
