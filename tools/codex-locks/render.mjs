/** 输出渲染：终端表格 + 预览/结果文本（按显示宽度对齐，兼容中英文混排）。 */

export function charWidth(cp) {
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch.codePointAt(0));
  return width;
}

export function pad(text, width) {
  const s = String(text);
  const diff = width - displayWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

export function truncate(text, width) {
  const s = String(text);
  if (displayWidth(s) <= width) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  const restMin = min % 60;
  if (hour < 24) return restMin ? `${hour}h${restMin}m` : `${hour}h`;
  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour ? `${day}d${restHour}h` : `${day}d`;
}

/** 2026-09-28 15:32 */
export function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function holderDetail(holder, callerTty = null) {
  if (holder.missing) return `PID ${holder.pid}（已退出）`;
  const bits = [
    `PID ${holder.pid}`,
    holder.tty ? `tty ${holder.tty}` : '无终端',
    holder.source ?? '未知来源',
    `已占 ${formatDuration(holder.ageMs)}`,
  ];
  if (holder.server) bits.push('app-server');
  let line = bits.join(' · ');
  if (callerTty && holder.tty === callerTty) line += '  ← 你当前终端';
  return line;
}

export function renderList(snap, { callerTty = null, all = false } = {}) {
  const rows = snap.sessions.filter((s) => (all ? true : s.locked));
  const locked = snap.sessions.filter((s) => s.locked).length;
  // 同一分钟里建的会话前 8 位可能相同，这种情况多显示几位
  const prefixes = rows.map((s) => s.threadId.slice(0, 8));
  const idWidth = prefixes.some((p, i) => prefixes.indexOf(p) !== i) ? 13 : 8;
  const lines = [];
  lines.push(`Codex 会话写锁 · ${snap.lockDir}`);
  lines.push(
    `共 ${snap.sessions.length} 个锁，${locked} 个被占用 · ${snap.sessions.length - locked} 个空闲` +
      (callerTty
        ? ` · 当前终端 ${callerTty}`
        : ' · 当前终端 无（非 tty 环境）'),
  );
  lines.push('');

  rows.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    const aa = a.holders[0]?.ageMs ?? 0;
    const bb = b.holders[0]?.ageMs ?? 0;
    if (aa !== bb) return bb - aa;
    return a.threadId.localeCompare(b.threadId);
  });

  if (rows.length === 0) lines.push('（没有被占用的会话）');

  for (const s of rows) {
    const marker = s.locked ? '●' : '○';
    const name = pad(truncate(s.name ?? '(无标题)', 24), 26);
    let detail = '—';
    if (s.locked) {
      detail = s.holders.map((h) => holderDetail(h, callerTty)).join('  ;  ');
      const last = s.lastActivityMs ?? s.updatedAt;
      if (last) detail += ` · 最后活动 ${formatDuration(snap.now - last)}前`;
    }
    lines.push(
      `${marker} ${pad(s.threadId.slice(0, idWidth), idWidth)}  ${name}${detail}`,
    );
  }

  if (!all && snap.sessions.length > locked) {
    lines.push('');
    lines.push(
      `（另有 ${snap.sessions.length - locked} 个空闲锁文件，--all 可一起列出）`,
    );
  }
  return lines.join('\n');
}

/** 清理预览/结果：每个待处理项两行（会话一行、进程一行）。 */
export function renderTargets(targets, { heading = '将结束这些进程' } = {}) {
  const lines = [`${heading}（${targets.length} 个）：`];
  for (const t of targets) {
    lines.push(
      `  · ${t.threadId.slice(0, 8)}  ${truncate(t.name ?? '(无标题)', 26)}`,
    );
    lines.push(`    ${holderDetail(t.holder)}`);
  }
  return lines.join('\n');
}

export function renderSkipped(skipped, { limit = 5 } = {}) {
  if (skipped.length === 0) return '';
  const groups = new Map();
  for (const s of skipped) {
    const list = groups.get(s.why) ?? [];
    list.push(s);
    groups.set(s.why, list);
  }
  const lines = [`跳过 ${skipped.length} 个：`];
  for (const [why, list] of [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    lines.push(
      `  · ${why} ×${list.length}` +
        (limit > 0
          ? `（${list
              .slice(0, limit)
              .map((s) => s.holder.pid)
              .join(', ')}${list.length > limit ? ', …' : ''}）`
          : ''),
    );
  }
  return lines.join('\n');
}
