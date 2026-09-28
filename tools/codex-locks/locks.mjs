/**
 * Codex 会话写锁：找出「谁占着哪个会话」。
 *
 * Codex 用 `~/.codex/thread-writer-locks/<threadId>.lock` 上的文件锁（flock）保证同一个
 * 会话只有一个写者。只要还有进程开着这个锁文件，`codex resume <id>` 就会报
 *
 *   thread <id> already has an active writer
 *
 * 注意两点：
 *   1. 锁文件残留（持有进程早就退了）**不等于**被占用 —— 判断依据是「有没有进程开着它」；
 *   2. Ctrl+Z / SIGSTOP 只是把进程挂起，fd 没关，锁照样占着，必须让进程**退出**。
 *
 * 实现：扫 /proc/<pid>/fd 找持有者，仅支持 Linux。
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HZ = 100; // Linux x86_64 上 USER_HZ 恒为 100
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KILLABLE_COMMS = new Set([
  'codex',
  'codex-acp',
  'node',
  'bun',
  'deno',
  'electron',
]);

/** 允许被本工具结束的进程名（避免误杀别的程序）。 */
export function isKillableComm(comm) {
  return KILLABLE_COMMS.has(String(comm).toLowerCase());
}

export function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function lockDirPath(codexHome = defaultCodexHome()) {
  return join(codexHome, 'thread-writer-locks');
}

/** 列出锁文件（含没被占用、只是残留的）。 */
export function listLocks(codexHome = defaultCodexHome()) {
  const dir = lockDirPath(codexHome);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { dir, exists: false, locks: [] };
  }
  const locks = names
    .filter((n) => n.endsWith('.lock') && !n.startsWith('.'))
    .map((n) => ({ threadId: n.slice(0, -'.lock'.length), path: join(dir, n) }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  return { dir, exists: true, locks };
}

export function listPids() {
  try {
    return readdirSync('/proc')
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
}

function procStat(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm 可能带空格/括号，按最后一个 ')' 切分最稳
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  return {
    comm: raw.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]) || 0,
    ttyNr: Number(rest[4]) || 0,
    startTicks: Number(rest[19]) || 0,
  };
}

function procArgs(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function procUid(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(
      /^Uid:\s+(\d+)/m,
    );
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function procCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function bootTimeMs() {
  try {
    const m = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** tty_nr -> 'pts/15' / 'tty1'（与 `ps -o tty` 一致）。 */
export function ttyName(ttyNr) {
  if (!ttyNr || ttyNr <= 0) return null;
  const major = (ttyNr >> 8) & 0xfff;
  const minor = ttyNr & 0xff;
  if (major >= 136 && major <= 143) return `pts/${(major - 136) * 256 + minor}`;
  if (major === 4) return `tty${minor}`;
  return null;
}

export function processTable() {
  const table = new Map();
  for (const pid of listPids()) {
    const st = procStat(pid);
    if (!st) continue;
    table.set(pid, { pid, ...st, args: procArgs(pid), uid: procUid(pid) });
  }
  return table;
}

const SOURCE_PATTERNS = [
  [/code-server/, 'code-server'],
  [/trae/, 'trae'],
  [/vscode/, 'vscode'],
  [/cursor/, 'cursor'],
  [/tmux/, 'tmux'],
  [/screen/, 'screen'],
  [/sshd?\b/, 'ssh'],
];

/** 顺着父进程往上看，判断进程跑在什么环境里（code-server / trae / tmux / ssh …）。 */
export function processSource(pid, table, maxDepth = 10) {
  let cur = pid;
  const seen = new Set();
  for (let i = 0; i < maxDepth && cur > 1; i += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const info = table.get(cur);
    if (!info) break;
    const text = `${info.comm} ${info.args.join(' ')}`.toLowerCase();
    for (const [re, label] of SOURCE_PATTERNS) {
      if (re.test(text)) return label;
    }
    cur = info.ppid;
  }
  return null;
}

/**
 * 谁开着这些锁文件：lockPath -> [pid, ...]
 * 用 dev:ino 比对（不依赖路径写法），没被任何人开着的锁就是「空闲」的。
 */
export function findHolders(locks) {
  const byInode = new Map();
  for (const lock of locks) {
    try {
      const st = statSync(lock.path);
      byInode.set(`${st.dev}:${st.ino}`, lock.path);
    } catch {
      // 锁文件不在了，跳过
    }
  }
  const holders = new Map();
  if (byInode.size === 0) return holders;

  for (const pid of listPids()) {
    const fdDir = `/proc/${pid}/fd`;
    let fds;
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue; // 别的用户 / 已退出
    }
    for (const fd of fds) {
      const fdPath = `${fdDir}/${fd}`;
      let target;
      try {
        target = readlinkSync(fdPath);
      } catch {
        continue;
      }
      if (!target.endsWith('.lock')) continue;
      let st;
      try {
        st = statSync(fdPath);
      } catch {
        continue;
      }
      const path = byInode.get(`${st.dev}:${st.ino}`);
      if (!path) continue;
      const list = holders.get(path) ?? [];
      if (!list.includes(pid)) list.push(pid);
      holders.set(path, list);
    }
  }
  return holders;
}

/** 会话标题：~/.codex/session_index.jsonl（同一个 id 取最新一条）。 */
export function readSessionIndex(codexHome = defaultCodexHome()) {
  const map = new Map();
  let raw;
  try {
    raw = readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.id) continue;
    const at = row.updated_at ? Date.parse(row.updated_at) : 0;
    const prev = map.get(row.id);
    if (!prev || at >= prev.at)
      map.set(row.id, { name: row.thread_name ?? null, at });
  }
  return map;
}

/** 会话记录文件：threadId -> { path, mtimeMs }（用 mtime 当「最后一次活动」）。 */
export function indexRollouts(codexHome = defaultCodexHome()) {
  const index = new Map();
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.name.startsWith('rollout-') || !ent.name.endsWith('.jsonl'))
        continue;
      const id = ent.name.slice(0, -'.jsonl'.length).slice(-36);
      if (!UUID_RE.test(id)) continue;
      let mtimeMs = null;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        // 忽略
      }
      const prev = index.get(id);
      if (!prev || (mtimeMs ?? 0) >= (prev.mtimeMs ?? 0))
        index.set(id, { path: full, mtimeMs });
    }
  };
  walk(join(codexHome, 'sessions'), 0);
  return index;
}

/** 注入到 prompt 里的「上下文块」，做标题时要先剥掉。 */
const PREAMBLE_PATTERNS = [
  /^<environment_context>[\s\S]*?<\/environment_context>\s*/,
  /^<skills_instructions>[\s\S]*?<\/skills_instructions>\s*/,
  /^<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>\s*/,
  /^<file path="[^"]*">[\s\S]*?<\/file>\s*/,
  /^#[^\n]*(AGENTS\.md|agent memory)[^\n]*\n[\s\S]*?<\/INSTRUCTIONS>\s*/,
  /^-{3,}\s*/,
];

const BOT_TEXT =
  /^(the following is the codex agent history|you are judging|you are `?\/root`?)/i;

export function stripPreamble(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 12; i += 1) {
    const before = out;
    for (const re of PREAMBLE_PATTERNS) {
      out = out.replace(re, '');
      if (out !== before) break;
    }
    if (out === before) break;
  }
  return out.trim();
}

function titleFromText(text) {
  const cleaned = unwrapFeishu(stripPreamble(text));
  if (!cleaned || BOT_TEXT.test(cleaned)) return null;
  const oneLine = cleaned.replace(/\s+/g, ' ').trim();
  return oneLine.length >= 2 ? oneLine.slice(0, 60) : null;
}

/** acp-claw 塞进来的飞书消息：`[feishu] from ou_xxx: {"text":"..."}` -> 取里面的 text。 */
function unwrapFeishu(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.text === 'string') return parsed.text.trim();
    } catch {
      // 不是合法 JSON（比如字符串里有真实换行），退化成正则抠 "text" 字段
      const m = trimmed.match(/^\{"text":"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`).trim();
        } catch {
          return m[1].trim();
        }
      }
    }
  }
  const at = text.indexOf('[feishu] from ');
  if (at === -1) return text;
  const rest = text.slice(at);
  const colon = rest.indexOf(': ');
  if (colon === -1) return rest.trim();
  const body = rest.slice(colon + 2).trim();
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.text === 'string') return parsed.text.trim();
  } catch {
    // 不是 JSON 就原样返回
  }
  return body;
}

/** 没有标题时的兜底标签：机器人 / 子 agent / 终端 + 目录。 */
export function fallbackLabel(meta) {
  if (!meta) return null;
  if (meta.thread_source === 'subagent' || meta.source?.subagent)
    return '[子 agent]';
  const origin = String(meta.originator ?? '');
  if (origin === 'acp-claw') return '[acp-claw 机器人]';
  if (origin.startsWith('codex_exec')) return '[codex exec]';
  const cwd = typeof meta.cwd === 'string' ? meta.cwd.replace(/\/+$/, '') : '';
  const base = cwd.split('/').pop();
  return base ? `[终端] ${base}` : null;
}

/** /home_ext/quyanyi/x -> ~/x（两种 home 写法都兼容）。 */
export function shortCwd(cwd) {
  const home = homedir();
  const path = String(cwd ?? '').replace(/\/+$/, '');
  if (!path) return '';
  const variants = new Set([
    home,
    home.replace('/home_ext/', '/home/'),
    home.replace('/home/', '/home_ext/'),
  ]);
  for (const h of variants) {
    if (!h) continue;
    if (path === h) return '~';
    if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

/**
 * 会话标题兜底：读 rollout 头部的 session_meta，以及第一条「像用户真说的话」。
 * session_index.jsonl 平时够用，但它未必即时更新（新建的会话常常还没有条目）。
 */
export function readRolloutHead(path, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { meta: null, title: null };
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0);
    let total = 0;
    let meta = null;
    while (total < maxBytes) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      total += read;
      const data = Buffer.concat([carry, chunk.subarray(0, read)]);
      let start = 0;
      for (;;) {
        const idx = data.indexOf(0x0a, start);
        if (idx === -1) break;
        const parsed = parseHeadLine(
          data.subarray(start, idx).toString('utf8'),
        );
        if (parsed?.meta && !meta) meta = parsed.meta;
        if (parsed?.title)
          return { meta: meta ?? parsed.meta, title: parsed.title };
        start = idx + 1;
      }
      carry = data.subarray(start);
    }
    return { meta, title: null };
  } finally {
    closeSync(fd);
  }
}

function parseHeadLine(line) {
  if (!line || line[0] !== '{') return null;
  if (
    !line.includes('"session_meta"') &&
    !line.includes('"user"') &&
    !line.includes('"user_message"')
  ) {
    return null;
  }
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row.type === 'session_meta')
    return { meta: row.payload ?? null, title: null };
  const payload = row.payload ?? {};
  if (
    row.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'user'
  ) {
    const text = (payload.content ?? []).map((c) => c?.text ?? '').join('');
    return { meta: null, title: titleFromText(text) };
  }
  if (row.type === 'event_msg' && payload.type === 'user_message') {
    return { meta: null, title: titleFromText(payload.message) };
  }
  return null;
}

function toHolder(pid, table, boot, now) {
  const info = table.get(pid);
  if (!info)
    return { pid, missing: true, comm: null, tty: null, interactive: false };
  const tty = ttyName(info.ttyNr);
  const startMs = boot ? boot + (info.startTicks / HZ) * 1000 : null;
  return {
    pid,
    comm: info.comm,
    args: info.args,
    uid: info.uid,
    ppid: info.ppid,
    tty,
    interactive: Boolean(tty),
    server: info.args.includes('app-server'),
    cwd: procCwd(pid),
    startMs,
    ageMs: startMs ? now - startMs : null,
    source: processSource(pid, table),
  };
}

/** 汇总：每个线程锁 + 它的持有者 + 会话名 + 最后活动时间。 */
export function snapshot(codexHome = defaultCodexHome()) {
  const { dir, exists, locks } = listLocks(codexHome);
  const holders = findHolders(locks);
  const table = processTable();
  const index = readSessionIndex(codexHome);
  const rollouts = indexRollouts(codexHome);
  const boot = bootTimeMs();
  const now = Date.now();

  const sessions = locks.map((lock) => {
    const pids = holders.get(lock.path) ?? [];
    const meta = index.get(lock.threadId);
    const rollout = rollouts.get(lock.threadId);
    const head =
      !meta?.name && rollout?.path
        ? readRolloutHead(rollout.path)
        : { meta: null, title: null };
    const holderList = pids.map((pid) => toHolder(pid, table, boot, now));
    const holderCwd = holderList.find((h) => h.cwd)?.cwd ?? null;
    const name =
      meta?.name ??
      head.title ??
      fallbackLabel(head.meta) ??
      (holderCwd ? `[终端] ${shortCwd(holderCwd)}` : null);
    return {
      threadId: lock.threadId,
      lockPath: lock.path,
      locked: pids.length > 0,
      name,
      updatedAt: meta?.at ?? null,
      lastActivityMs: rollout?.mtimeMs ?? null,
      rolloutPath: rollout?.path ?? null,
      holders: holderList,
    };
  });

  return {
    codexHome,
    lockDir: dir,
    lockDirExists: exists,
    now,
    sessions,
    table,
  };
}

/** 某个进程自己的 + 全部祖先 pid（用来保护当前调用链）。 */
export function ancestorPids(pid, table) {
  const set = new Set([pid]);
  let cur = pid;
  for (let i = 0; i < 16; i += 1) {
    const info = table.get(cur);
    if (!info?.ppid || info.ppid <= 1) break;
    set.add(info.ppid);
    cur = info.ppid;
  }
  return set;
}

/**
 * 挑出「该清理」的持有者（纯函数，便于测试）。
 * 默认只清**交互式 TUI**，后台 app-server（acp-claw 机器人的会话）默认保留。
 */
export function selectCleanTargets(sessions, options = {}) {
  const {
    callerTty = null,
    keep = [],
    includeServers = false,
    minIdleMs = 0,
    uid = null,
    force = false,
    ownPids = new Set(),
    selfPid = process.pid,
    now = Date.now(),
    keepNewestTui = true,
  } = options;

  const keepTtys = new Set(keep.filter((k) => /^(pts\/|tty)/.test(k)));
  const keepPids = new Set(
    keep.filter((k) => /^\d+$/.test(String(k))).map(Number),
  );
  const targets = [];
  const skipped = [];

  // 调用方不在 tty 里（例如机器人/脚本代跑）时无法知道「你的终端」是哪个，
  // 此时默认保留**最近打开的那个交互式会话**——它很可能正是用户正在用的。
  let newestTuiPid = null;
  if (callerTty === null && keepNewestTui) {
    let newest = null;
    for (const session of sessions) {
      for (const holder of session.holders ?? []) {
        if (!holder.interactive || holder.startMs == null) continue;
        if (uid != null && holder.uid != null && holder.uid !== uid) continue;
        if (!force && !isKillableComm(holder.comm)) continue;
        if (!newest || holder.startMs > newest.startMs) newest = holder;
      }
    }
    newestTuiPid = newest?.pid ?? null;
  }

  for (const session of sessions) {
    const lastActive = session.lastActivityMs ?? session.updatedAt ?? null;
    const idleMs = lastActive ? now - lastActive : null;
    for (const holder of session.holders ?? []) {
      const entry = {
        threadId: session.threadId,
        name: session.name ?? null,
        holder,
      };
      let why = null;
      if (holder.pid === selfPid) why = '当前进程';
      else if (ownPids.has(holder.pid)) why = '当前进程链';
      else if (keepPids.has(holder.pid)) why = '--keep 指定';
      else if (callerTty && holder.tty === callerTty) why = '当前终端';
      else if (holder.tty && keepTtys.has(holder.tty)) why = '--keep 指定';
      else if (holder.pid === newestTuiPid)
        why = '最近打开的终端（默认保留，可用 --no-keep-newest 放开）';
      else if (uid != null && holder.uid != null && holder.uid !== uid)
        why = '其他用户';
      else if (!force && !isKillableComm(holder.comm))
        why = `不是 codex 进程（${holder.comm}）`;
      else if (!includeServers && !holder.interactive)
        why = '后台 app-server（机器人会话，默认保留）';
      else if (minIdleMs > 0 && idleMs != null && idleMs < minIdleMs)
        why = '最近还有活动';
      if (why) skipped.push({ ...entry, why });
      else targets.push(entry);
    }
  }
  return { targets, skipped };
}
