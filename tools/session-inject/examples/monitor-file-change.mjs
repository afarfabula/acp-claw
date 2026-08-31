#!/usr/bin/env node
/**
 * 示例：监控文件变化，变化时向指定聊天会话注入一条消息。
 *
 * 注入后 LLM 会带着该会话的完整上下文推理，并把回复发回对应聊天，
 * 效果等同于「用户在这里发了一条 query」。
 *
 * 用法：
 *   node monitor-file-change.mjs --chat-id oc_xxx --file /path/to/target.log
 *   node monitor-file-change.mjs --chat-id oc_xxx --file ./data.json --interval 10000 --prompt "检测到数据文件变化，请帮我分析变化内容"
 */
import { readFileSync } from 'node:fs';
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
      '  node monitor-file-change.mjs --chat-id <chatId> --file <path> [--interval <ms>] [--prompt <text>]',
    ].join('\n'),
  );
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const chatId = flags['chat-id'];
  const file = flags.file;
  if (!chatId || !file) {
    usage();
    process.exit(1);
  }

  const interval = Number(flags.interval || 30_000);
  const prompt =
    flags.prompt ||
    `检测到文件 ${file} 发生了变化，请简要说明变化内容，如果值得注意就提醒我。`;

  let lastContent = null;
  try {
    lastContent = readFileSync(file, 'utf-8');
  } catch {
    lastContent = null;
  }

  console.log(
    `[monitor] watching ${file} every ${interval}ms, target chat: ${chatId}`,
  );

  const check = async () => {
    let content = null;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      return;
    }

    if (lastContent !== null && content !== lastContent) {
      console.log(`[monitor] change detected at ${new Date().toISOString()}`);
      const { status, data } = await injectMessage({ chatId, text: prompt });
      if (status !== 200) {
        console.error('[monitor] inject failed:', JSON.stringify(data));
      }
    }
    lastContent = content;
  };

  setInterval(check, interval).unref();
}

void main();
