#!/usr/bin/env node
/**
 * acp-claw session-inject 客户端
 *
 * 通过本地 Inject Channel 向指定会话注入消息，复用该会话的完整上下文。
 *
 * 用法：
 *   node client.mjs inject --chat-id oc_xxx --text "提醒内容"
 *   node client.mjs inject --session feishu_ou_xxx_1 --text "提醒内容"
 *   node client.mjs sessions
 *   node client.mjs health
 *
 * 配置（config.json）：
 *   { "inject": { "port": 41008, "token": "可选" } }
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function loadConfig() {
  const workDir =
    process.env.ACP_CLAW_WORK_DIR || join(process.cwd(), '.acp-claw');
  try {
    const raw = readFileSync(join(workDir, 'config.json'), 'utf-8');
    return { workDir, config: JSON.parse(raw) };
  } catch {
    return { workDir, config: {} };
  }
}

function getEndpoint() {
  const { config } = loadConfig();
  const inject = config.inject;
  if (!inject?.port) {
    throw new Error(
      '未配置 inject 通道：请在 config.json 添加 "inject": { "port": 41008 } 并重启 acp-claw 服务',
    );
  }
  const host = inject.host || '127.0.0.1';
  return { base: `http://${host}:${inject.port}`, token: inject.token };
}

async function api(path, { method = 'GET', body } = {}) {
  const { base, token } = getEndpoint();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  return { status: res.status, data };
}

/** 向会话注入一条消息（LLM 会带着该会话上下文推理并回复到对应聊天） */
export async function injectMessage({
  chatId,
  sessionKey,
  text,
  senderId = 'trigger',
  sourceChannel = 'feishu',
}) {
  if (!text) throw new Error('text is required');
  if (!chatId && !sessionKey) {
    throw new Error('chatId or sessionKey is required');
  }
  const { status, data } = await api('/inject', {
    method: 'POST',
    body: { chatId, sessionKey, text, senderId, sourceChannel },
  });
  return { status, data };
}

/** 列出当前活动会话（含 chatId 映射） */
export async function listSessions() {
  return api('/sessions');
}

/** 健康检查 */
export async function health() {
  return api('/health');
}

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
      '  node client.mjs inject --chat-id <chatId> --text <text> [--session <key>] [--sender-id <id>]',
      '  node client.mjs sessions',
      '  node client.mjs health',
    ].join('\n'),
  );
}

async function runCli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  try {
    if (cmd === 'inject') {
      const { status, data } = await injectMessage({
        chatId: flags['chat-id'],
        sessionKey: flags.session,
        text: flags.text,
        senderId: flags['sender-id'],
      });
      if (status !== 200) {
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
    } else if (cmd === 'sessions') {
      const { status, data } = await listSessions();
      if (status !== 200) {
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
    } else if (cmd === 'health') {
      const { status, data } = await health();
      if (status !== 200) {
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
    } else {
      usage();
      process.exit(1);
    }
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// 直接运行时执行 CLI；被 import 时只导出函数
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCli();
}
