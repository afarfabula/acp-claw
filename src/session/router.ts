/**
 * Build session key: {channel}_{userId}_{sessionId}
 */
export function getSessionKey(
  channel: string,
  userId: string,
  sessionId: number | string = 1,
): string {
  if (userId) {
    return `${channel}_${userId}_${sessionId}`;
  }
  return 'default';
}

/**
 * Get user prefix for listing/matching sessions: {channel}_{userId}_
 */
export function getUserPrefix(channel: string, userId: string): string {
  return `${channel}_${userId}_`;
}

/**
 * 本地日期键（YYYY-MM-DD），用于「当天会话」判定。
 */
export function localDayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse session key into components
 */
export function parseSessionKey(
  key: string,
): { channel: string; userId: string; sessionId: number } | null {
  // Match pattern: {channel}_{userId}_{sessionId}
  // userId can contain underscores (e.g. ou_xxx), so we split from the end
  const lastUnderscore = key.lastIndexOf('_');
  if (lastUnderscore === -1) return null;

  const sessionId = Number.parseInt(key.slice(lastUnderscore + 1), 10);
  if (Number.isNaN(sessionId)) return null;

  const prefix = key.slice(0, lastUnderscore);
  const firstUnderscore = prefix.indexOf('_');
  if (firstUnderscore === -1) return null;

  const channel = prefix.slice(0, firstUnderscore);
  const userId = prefix.slice(firstUnderscore + 1);

  return { channel, userId, sessionId };
}
