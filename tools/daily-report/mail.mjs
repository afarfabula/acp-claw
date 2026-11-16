import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localParts, readState, resolveDataDir, writeState } from './state.mjs';

const MAIL_CLI = join(
  homedir(),
  '.acp-claw',
  'tools',
  'netease-mail',
  'cli.mjs',
);

function runMail(args) {
  const result = spawnSync(process.execPath, [MAIL_CLI, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(`163 邮箱读取失败: ${detail || `exit=${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

function parseMessageDate(message) {
  const ms = Date.parse(message.date || '');
  return Number.isNaN(ms) ? null : ms;
}

function cleanSnippet(text, subject) {
  if (/验证码|verification code|一次性密码|\botp\b/i.test(subject)) {
    return '[含验证码，正文已省略]';
  }
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

function renderMarkdown({ newMessages, unreadMessages, details }) {
  const lines = [
    '📧 邮箱',
    `本次新增 ${newMessages.length} 封，其中未读 ${newMessages.filter((item) => item.unread).length} 封；近 7 天未读 ${unreadMessages.length} 封。`,
  ];
  if (details.length) {
    for (const item of details.slice(0, 5)) {
      const summary = item.snippet ? `：${item.snippet}` : '';
      lines.push(`- ${item.from || '未知发件人'}｜${item.subject}${summary}`);
    }
  } else {
    lines.push('本次窗口没有新邮件。');
  }
  return lines.join('\n');
}

export async function collectMailDigest(cfg, flags = {}) {
  const now = new Date();
  const parts = localParts(now, cfg.timezone);
  const state = readState();
  const previous = state.mail?.lastCheckAt
    ? new Date(state.mail.lastCheckAt)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const maxLookback = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since = previous < maxLookback ? maxLookback : previous;
  const searchDays = Math.max(
    2,
    Math.ceil((now.getTime() - since.getTime()) / 86_400_000) + 1,
  );

  const allRecent =
    runMail([
      'search',
      '--days',
      String(searchDays),
      '--limit',
      '100',
      '--json',
    ]).messages || [];
  const unreadRecent =
    runMail([
      'search',
      '--unread',
      '--days',
      '7',
      '--limit',
      '100',
      '--json',
    ]).messages || [];

  const newMessages = allRecent
    .filter((message) => {
      const timestamp = parseMessageDate(message);
      return timestamp !== null && timestamp > since.getTime();
    })
    .sort(
      (a, b) => (parseMessageDate(b) || 0) - (parseMessageDate(a) || 0),
    );

  const detailCandidates = newMessages
    .filter(
      (message) =>
        !/优惠|促销|广告|订阅|newsletter|unsubscribe|推广/i.test(
          `${message.from || ''} ${message.subject || ''}`,
        ),
    )
    .slice(0, Math.max(0, Number(flags.details ?? cfg.mail?.maxDetails ?? 6)));

  const details = [];
  for (const message of detailCandidates) {
    try {
      const full = runMail([
        'read',
        String(message.uid),
        '--max-chars',
        '1600',
        '--json',
      ]);
      details.push({
        uid: message.uid,
        from: message.from,
        subject: message.subject,
        date: message.date,
        unread: message.unread,
        snippet: cleanSnippet(full.text, message.subject),
        attachments: full.attachments,
      });
    } catch {
      details.push({
        ...message,
        snippet: '',
        attachments: [],
      });
    }
  }

  const markdown = renderMarkdown({
    newMessages,
    unreadMessages: unreadRecent,
    details,
  });
  state.mail = {
    lastCheckAt: now.toISOString(),
    lastRunDate: parts.date,
    newMessages: newMessages.length,
    unreadMessages: unreadRecent.length,
  };
  writeState(state);

  const dataDir = resolveDataDir(cfg);
  mkdirSync(dataDir, { recursive: true });
  const jsonPath = join(
    dataDir,
    `${parts.date}-mail-${parts.time.replace(':', '')}.json`,
  );
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        since: since.toISOString(),
        newMessages,
        unreadRecent,
        details,
        markdown,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    jsonPath,
    markdown,
    newCount: newMessages.length,
    unreadCount: unreadRecent.length,
  };
}
