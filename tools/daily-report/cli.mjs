#!/usr/bin/env node
/**
 * 日报工具（acp-claw）
 *
 *   node cli.mjs collect [--out <file>] [--json]     采集素材 → data/<date>.json + <date>-brief.md，默认打印素材 Markdown
 *   node cli.mjs publish --file <md> [--doc auto|<url|id>] [--chat <chatId>]
 *                                                    把日报写入飞书文档（默认按月份自动建/找文档）；--chat 时同时发群
 *   node cli.mjs config                              打印当前运行时配置路径与内容
 *
 * 配置：~/.acp-claw/daily-report/config.json（不存在则用仓库示例配置）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig,
  localParts,
  readState,
  resolveDataDir,
  stateFile,
  writeState,
} from './state.mjs';
import {
  collectBalance,
  collectInfra,
  collectPapers,
  collectProjects,
  collectWeather,
} from './collect.mjs';
import { renderBrief } from './render.mjs';
import { appendDoc, docTitleFromPattern, ensureDoc, sendChatMessage } from './feishu.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function cmdCollect(flags) {
  const { config: cfg, path: cfgPath, missing } = loadConfig();
  if (missing) console.error(`⚠️  未找到运行时配置 ${cfgPath}，使用仓库示例配置`);
  const failures = [];
  const [weather, balance, papers, infra, projects] = await Promise.all([
    collectWeather(cfg, failures),
    collectBalance(cfg, failures),
    collectPapers(cfg, failures),
    collectInfra(cfg, failures),
    collectProjects(cfg, failures),
  ]);
  const parts = localParts(new Date(), cfg.timezone);
  const data = {
    meta: {
      ...parts,
      timezone: cfg.timezone,
      generatedAt: new Date().toISOString(),
      failures,
    },
    weather,
    balance,
    papers,
    infra,
    projects,
  };
  const brief = renderBrief(data, { timeZone: cfg.timezone });
  const dataDir = resolveDataDir(cfg);
  const jsonPath = flags.out ? String(flags.out) : join(dataDir, `${parts.date}.json`);
  const briefPath = join(dataDir, `${parts.date}-brief.md`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
  writeFileSync(briefPath, brief, 'utf-8');
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ jsonPath, briefPath, failures }, null, 2)}\n`);
  } else {
    process.stdout.write(`${brief}\n`);
    process.stderr.write(`\n[collect] 素材已写入 ${briefPath} / ${jsonPath}\n`);
  }
  if (failures.length) process.stderr.write(`[collect] 失败项: ${failures.join(' | ')}\n`);
}

async function cmdPublish(flags) {
  const { config: cfg } = loadConfig();
  const file = flags.file;
  if (!file || typeof file !== 'string') throw new Error('缺少 --file <markdown 文件>');
  const markdown = readFileSync(file, 'utf-8');
  const parts = localParts(new Date(), cfg.timezone);
  const state = readState();
  const result = { date: parts.date };

  if (flags.doc !== 'none') {
    let docRef;
    if (flags.doc && flags.doc !== 'auto' && typeof flags.doc === 'string') {
      docRef = { url: flags.doc };
    } else {
      const title = docTitleFromPattern(flags.title ?? cfg.feishu?.docTitlePattern, parts);
      docRef = ensureDoc(title, state);
      if (docRef.created) result.docCreated = docRef.url;
    }
    result.docAppended = appendDoc(docRef, markdown);
    result.docUrl = docRef.url;
  }

  const chatId = typeof flags.chat === 'string' ? flags.chat : undefined;
  if (chatId) {
    result.chatMessageId = await sendChatMessage(chatId, markdown);
  }

  state.lastRun = { date: parts.date, stamp: parts.stamp, docUrl: result.docUrl };
  writeState(state);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`[publish] state: ${stateFile()}\n`);
}

function cmdConfig() {
  const { config, path, missing } = loadConfig();
  process.stdout.write(
    `${JSON.stringify({ path, missing, dataDir: resolveDataDir(config), config }, null, 2)}\n`,
  );
}

const COMMANDS = { collect: cmdCollect, publish: cmdPublish, config: cmdConfig };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const header = readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0];
    process.stdout.write(`${header.replace(/^\/\*\*?/, '').trim()}\n`);
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) throw new Error(`未知命令: ${cmd}（可用：${Object.keys(COMMANDS).join(' / ')}）`);
  const { flags, positional } = parseArgs(rest);
  await handler(flags, positional);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
