/** 结束进程 + 复查锁是否真的释放（CLI 和 TUI 共用）。 */

import { snapshot } from './locks.mjs';

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function waitForExit(pids, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter((p) => p > 1 && isAlive(p));
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    alive = alive.filter((p) => isAlive(p));
  }
  return alive;
}

/**
 * 结束 targets（[{ threadId, holder }]）里的进程，然后复查锁。
 * 返回 { killed, failed, released, stillLocked, aliveAfter }
 */
export function releaseTargets(codexHome, targets, { timeoutMs = 3000 } = {}) {
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

  const aliveAfter = waitForExit(
    killed.map((t) => t.holder.pid),
    timeoutMs,
  );

  const touched = new Set(targets.map((t) => t.threadId));
  const released = [];
  const stillLocked = [];
  for (const session of snapshot(codexHome).sessions) {
    if (!touched.has(session.threadId)) continue;
    if (session.locked)
      stillLocked.push({
        threadId: session.threadId,
        holders: session.holders.map((h) => h.pid),
      });
    else released.push(session.threadId);
  }
  return { killed, failed, released, stillLocked, aliveAfter };
}
