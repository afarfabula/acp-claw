#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { initWorkDir, loadConfig, resolveWorkDir } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
);

const program = new Command();

program
  .name('acp-claw')
  .description('ACP protocol based Claw client with Feishu channel')
  .version(pkgJson.version)
  .option('--work-dir <path>', '工作目录路径');

program
  .command('init')
  .description('初始化配置文件和记忆目录')
  .action(() => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const config = initWorkDir(workDir);
    console.log(`✅ 已初始化工作目录: ${workDir}`);
    console.log(`   默认 Agent: ${config.defaultAgent}`);
    console.log(`   可用 Agents: ${Object.keys(config.agents).join(', ')}`);
    if (config.feishu) {
      console.log(`   飞书 Channel: 已配置`);
    } else {
      console.log(
        `   飞书 Channel: 未配置 (设置 LARK_APP_ID 和 LARK_APP_SECRET 环境变量或编辑 config.json)`,
      );
    }
  });

program
  .command('run', { isDefault: true })
  .description('启动 ACP Claw 服务')
  .action(async () => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const config = loadConfig(workDir);

    const { Controller } = await import('./app/controller.js');
    const controller = new Controller(config, workDir);
    await controller.start();
  });

program
  .command('update')
  .description('更新 acp-claw 到最新版本')
  .action(() => {
    const needsSudo = (() => {
      try {
        const prefixResult = spawnSync('npm', ['config', 'get', 'prefix'], {
          encoding: 'utf-8',
        });
        const globalPrefix = prefixResult.stdout?.trim();
        if (!globalPrefix) return true;
        const globalLibDir = join(globalPrefix, 'lib');
        const dirToCheck = existsSync(globalLibDir)
          ? globalLibDir
          : globalPrefix;
        accessSync(dirToCheck, fsConstants.W_OK);
        return false;
      } catch {
        return true;
      }
    })();

    const runCommand = (cmd: string, args: string[]) => {
      if (needsSudo) {
        return spawnSync('sudo', [cmd, ...args], { stdio: 'inherit' });
      }
      return spawnSync(cmd, args, { stdio: 'inherit' });
    };

    console.log(
      needsSudo
        ? '🔐 全局 npm 目录需要提权，使用 sudo...'
        : '✅ 全局 npm 目录可写，无需 sudo。',
    );

    console.log('🧹 清理 npm 缓存...');
    const cleanResult = runCommand('npm', ['cache', 'clean', '--force']);
    if (cleanResult.status !== 0) {
      console.error('❌ 清理 npm 缓存失败');
      process.exit(1);
    }

    console.log('📦 安装最新版 acp-claw...');
    const installResult = runCommand('npm', [
      'install',
      '-g',
      '--force',
      'acp-claw',
    ]);
    if (installResult.status !== 0) {
      console.error('❌ 安装最新版本失败');
      process.exit(1);
    }

    console.log('✅ 更新完成！');
  });

function getInjectEndpoint(workDir: string): {
  baseUrl: string;
  token?: string;
} {
  const config = loadConfig(workDir);
  const inject = config.inject;
  if (!inject) {
    throw new Error(
      'Inject channel 未配置，请在 config.json 中添加 "inject": { "port": 41008 } 并重启服务',
    );
  }
  return {
    baseUrl: `http://${inject.host ?? '127.0.0.1'}:${inject.port}`,
    token: inject.token,
  };
}

async function requestInject(
  path: string,
  workDir: string,
  init?: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const { baseUrl, token } = getInjectEndpoint(workDir);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

const sessionCmd = program.command('session').description('会话管理');

sessionCmd
  .command('list')
  .description('列出当前活动会话（含 chatId 映射）')
  .action(async () => {
    const workDir = resolveWorkDir(program.opts().workDir);
    try {
      const { status, data } = await requestInject('/sessions', workDir);
      if (status !== 200) {
        console.error(JSON.stringify(data));
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(
        '❌ 无法连接 Inject Channel（服务未启动或未配置 inject）:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

program
  .command('inject')
  .description('向指定会话注入一条消息（复用该会话上下文，需要服务已启动）')
  .option('--session <sessionKey>', '目标会话 Key（如 feishu_ou_xxx_1）')
  .option('--chat-id <chatId>', '目标聊天 ID')
  .requiredOption('--text <text>', '要注入的消息内容')
  .option('--sender-id <senderId>', '发送者标识（默认 trigger）')
  .action(async (opts) => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const body: Record<string, string> = { text: opts.text };
    if (opts.session) body.sessionKey = opts.session;
    if (opts.chatId) body.chatId = opts.chatId;
    if (opts.senderId) body.senderId = opts.senderId;
    if (!body.sessionKey && !body.chatId) {
      console.error('❌ 请提供 --session 或 --chat-id 之一');
      process.exit(1);
    }
    try {
      const { status, data } = await requestInject('/inject', workDir, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (status !== 200) {
        console.error(JSON.stringify(data));
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(
        '❌ 无法连接 Inject Channel（服务未启动或未配置 inject）:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

const cronCmd = program.command('cron').description('管理定时任务');

cronCmd
  .command('add')
  .description('添加定时任务')
  .requiredOption('--name <name>', '任务名称')
  .requiredOption('--schedule <schedule>', 'Cron 表达式 (5 字段)')
  .requiredOption('--prompt <prompt>', '触发时的提示词')
  .option('--chat-id <chatId>', '目标聊天 ID')
  .option(
    '--session <sessionKey>',
    '目标会话 Key（复用该会话上下文而非新建会话）',
  )
  .option(
    '--fresh-session',
    '每次触发新建会话（不复用上次上下文），本轮结束后关闭该会话',
    false,
  )
  .option('--one-shot', '执行一次后自动删除', false)
  .action(async (opts) => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const { SchedulerChannel } = await import('./channel/scheduler.js');
    const service = new SchedulerChannel(workDir);
    const result = service.addTask({
      name: opts.name,
      schedule: opts.schedule,
      prompt: opts.prompt,
      chatId: opts.chatId,
      sessionKey: opts.session,
      freshSession: opts.freshSession,
      oneShot: opts.oneShot,
    });
    if (result.success) {
      console.log(
        JSON.stringify({
          success: true,
          name: opts.name,
          schedule: opts.schedule,
        }),
      );
    } else {
      console.error(JSON.stringify({ success: false, error: result.error }));
      process.exit(1);
    }
  });

cronCmd
  .command('delete')
  .description('删除定时任务')
  .requiredOption('--name <name>', '任务名称')
  .action(async (opts) => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const { SchedulerChannel } = await import('./channel/scheduler.js');
    const service = new SchedulerChannel(workDir);
    const result = service.deleteTask(opts.name);
    if (result.success) {
      console.log(JSON.stringify({ success: true, deleted: opts.name }));
    } else {
      console.error(JSON.stringify({ success: false, error: result.error }));
      process.exit(1);
    }
  });

cronCmd
  .command('list')
  .description('列出所有定时任务')
  .action(async () => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const { SchedulerChannel } = await import('./channel/scheduler.js');
    const service = new SchedulerChannel(workDir);
    const tasks = service.listTasks();
    console.log(JSON.stringify({ tasks, count: tasks.length }, null, 2));
  });

cronCmd
  .command('toggle')
  .description('启用/禁用定时任务')
  .requiredOption('--name <name>', '任务名称')
  .requiredOption('--enabled <enabled>', '启用状态 (true/false)')
  .action(async (opts) => {
    const workDir = resolveWorkDir(program.opts().workDir);
    const { SchedulerChannel } = await import('./channel/scheduler.js');
    const service = new SchedulerChannel(workDir);
    const enabled = opts.enabled === 'true';
    const result = service.toggleTask(opts.name, enabled);
    if (result.success) {
      console.log(JSON.stringify({ success: true, name: opts.name, enabled }));
    } else {
      console.error(JSON.stringify({ success: false, error: result.error }));
      process.exit(1);
    }
  });

program.parse();
