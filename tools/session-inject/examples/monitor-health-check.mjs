#!/usr/bin/env node
/**
 * 示例：监控某个 URL 的健康状态，状态发生切换（可用 ↔ 不可用）时，
 * 向指定聊天会话注入一条消息，让 LLM 带着会话上下文处理。
 *
 * 用法：
 *   node monitor-health-check.mjs --chat-id oc_xxx --url https://example.com/health
 *   node monitor-health-check.mjs --chat-id oc_xxx --url https://example.com --interval 60000
 */
import { injectMessage } from '../client.mjs';

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  console.log(
    [
      '用法:',
      '  node monitor-health-check.mjs --chat-id <chatId> --url <url> [--interval <ms>]',
    ].join('\n'),
  );
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const chatId = flags['chat-id'];
  const url = flags.url;
  if (!chatId || !url) {
    usage();
    process.exit(1);
  }

  const interval = Number(flags.interval || 60_000);
  let lastUp = null;

  console.log(
    `[monitor] watching ${url} every ${interval}ms, target chat: ${chatId}`,
  );

  const check = async () => {
    const up = await checkUrl(url);
    if (lastUp !== null && up !== lastUp) {
      const statusText = up ? '已恢复 🟢' : '现在不可用 🔴';
      console.log(
        `[monitor] status change: ${url} ${statusText} at ${new Date().toISOString()}`,
      );
      const { status, data } = await injectMessage({
        chatId,
        text: `服务 ${url} 状态变化：${statusText}，请帮我看看并给出处理建议。`,
      });
      if (status !== 200) {
        console.error('[monitor] inject failed:', JSON.stringify(data));
      }
    }
    lastUp = up;
  };

  await check();
  setInterval(check, interval).unref();
}

void main();
