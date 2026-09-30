#!/usr/bin/env node
/**
 * 日报工具（acp-claw）
 *
 *   node cli.mjs collect [--out <file>] [--json]     采集素材 → data/<date>.json + <date>-brief.md，默认打印素材 Markdown
 *   node cli.mjs news [--json]                       采集 AI 新闻素材 → data/<date>-news.json + <date>-news.md
 *   node cli.mjs school [--json] [--days N] [--all]  采集学校/学院通知（信通学院+研究生院+学工部）
 *                                                    → data/<date>-school.json + <date>-school.md
 *                                                    （默认只标「新增」并记录已读；--all 忽略已读且不回写，--no-detail 不抓正文）
 *   node cli.mjs publish --file <md> [--doc auto|<url|id>] [--chat <chatId>]
 *                                                    把日报写入飞书文档（默认按月份自动建/找文档）；--chat 时同时发群
 *                                                    写入前会规范化：条目标题 `## YYYY-MM-DD HH:MM`、
 *                                                    栏目固定顺序，并插到「按时间倒序」的正确位置
 *   node cli.mjs doc-tree [--file <md>] [--doc <url>]  解析并打印文档里的简报条目（不写任何东西）
 *   node cli.mjs fixdoc [--dry] [--backup-dir <dir>]   重排/规范化已存在的日报文档（先备份再整体重写）
 *   node cli.mjs affil <id|url> [...] [--json]       查论文的「完成单位」（机构/团队）与作者
 *                                                    （解析 arXiv HTML 版的作者块；太老的论文可能没有 HTML 版）
 *   node cli.mjs comments [<doc|url>] [--json] [--all] [--rebuild]
 *                                                    列文档批注，并标出「还没处理过」的（增量，记在 state.json）
 *   node cli.mjs reply <doc|url> <commentId> --text "…" [--no-solve]
 *                                                    在批注里回复（默认同时标记「已解决」，并记进度不再重复处理）
 *   node cli.mjs config                              打印当前运行时配置路径与内容
 *
 * 配置：~/.acp-claw/daily-report/config.json（不存在则用仓库示例配置）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expandHome,
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
import { renderBrief, renderNews, renderSchool } from './render.mjs';
import { collectNews } from './news.mjs';
import { collectSchool } from './school.mjs';
import { fetchAffiliation } from './affil.mjs';
import {
  listComments,
  pickPending,
  postReply,
  renderComment,
  resolveDocId,
  setSolved,
} from './comments.mjs';
import {
  appendDoc,
  deleteDocRange,
  docTitleFromPattern,
  docBlocks,
  docMarkdown,
  ensureDoc,
  insertDocMarkdown,
  sendMessage,
} from './feishu.mjs';
import {
  applyFixes,
  inferMissingDates,
  entrySpans,
  mergeFragments,
  normalizeEntryMarkdown,
  parseEntries,
  renderDoc,
  tsOf,
} from './docfmt.mjs';

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
    const date = typeof flags.date === 'string' ? flags.date : parts.date;
    const time = typeof flags.time === 'string' ? flags.time : parts.time;
    const entry = normalizeEntryMarkdown(markdown, { date, time });
    result.entry = `${date} ${time}`;
    result.docAppended = publishEntry(docRef, entry, { date, time });
    result.docUrl = docRef.url;
  }

  const chatId = typeof flags.chat === 'string' ? flags.chat : undefined;
  if (chatId) {
    result.chatMessageId = await sendMessage(chatId, markdown, 'chat_id');
  }
  const openId = typeof flags['open-id'] === 'string' ? flags['open-id'] : undefined;
  if (openId) {
    result.openMessageId = await sendMessage(openId, markdown, 'open_id');
  }

  state.lastRun = { date: parts.date, stamp: parts.stamp, docUrl: result.docUrl };
  writeState(state);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`[publish] state: ${stateFile()}\n`);
}

/**
 * 把一条规范化的简报写进文档：按时间倒序插入到正确位置。
 * 同一「日期 + 时间」已存在时，先删掉旧块再写（重复推送不会留两份）。
 */
function publishEntry(docRef, entryMarkdown, { date, time }) {
  const newTs = Date.parse(`${date}T${time}:00+08:00`);
  let layout;
  try {
    layout = docBlocks(docRef);
  } catch (err) {
    process.stderr.write(`[publish] 读取文档结构失败（${err.message}），回退为直接追加\n`);
    return appendDoc(docRef, entryMarkdown);
  }
  if (!layout?.blocks?.length) return appendDoc(docRef, entryMarkdown);

  const spans = entrySpans(layout.blocks);
  inferMissingDates(spans.entries);
  const dup = spans.entries.find((e) => e.date === date && e.time === time);
  if (dup) deleteDocRange(docRef, dup.start, dup.end);
  const others = spans.entries.filter((e) => e !== dup);
  const newer = others.filter((e) => (tsOf(e) ?? 0) > newTs);
  const index = (spans.headerBlocks.length || 0) + newer.reduce((n, e) => n + (e.end - e.start), 0);
  return insertDocMarkdown(docRef, entryMarkdown, index);
}

/** 读取「文档 + 解析结果」，供 doc-tree / fixdoc 复用 */
function readDocEntries(flags) {
  const { config: cfg } = loadConfig();
  const parts = localParts(new Date(), cfg.timezone);
  const state = readState();
  let md;
  let docRef = null;
  if (typeof flags.file === 'string') {
    md = readFileSync(flags.file, 'utf-8');
  } else {
    if (flags.doc && flags.doc !== 'auto' && typeof flags.doc === 'string') {
      docRef = { url: flags.doc };
    } else {
      const title = docTitleFromPattern(flags.title ?? cfg.feishu?.docTitlePattern, parts);
      docRef = ensureDoc(title, state);
    }
    md = docMarkdown(docRef);
  }
  const { header, entries: parsed } = parseEntries(md);
  let entries = parsed;
  let fixes = { dropped: 0, patched: 0 };
  if (flags['no-infer']) {
    // 保持原样，仅用于排查
  } else {
    entries = mergeFragments(entries);
    if (typeof flags.fixes === 'string') {
      fixes = applyFixes(entries, JSON.parse(readFileSync(flags.fixes, 'utf-8')));
      entries = fixes.entries;
    }
    inferMissingDates(entries);
  }
  return { cfg, parts, state, md, docRef, header, entries, fixes };
}

/** 读 `--text`：支持直接给字符串，也支持 @文件路径 */
function readTextArg(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith('@')) return readFileSync(expandHome(v.slice(1)), 'utf-8');
  return v;
}

/** 取本次要处理的文档：--doc > 位置参数 > 配置里的 paperReading.docId */
function pickDocId(flags, positional, cfg) {
  const raw = flags.doc ?? positional?.[0] ?? cfg.paperReading?.docId;
  const id = resolveDocId(raw);
  if (!id) {
    throw new Error('没找到要处理的文档：用 --doc <url|id>，或在 config.json 里设 paperReading.docId');
  }
  return id;
}

/** 批注处理进度存在 state.json 的 paperReading.docs.<docId> 下 */
function commentState(state, docId) {
  state.paperReading ??= {};
  state.paperReading.docs ??= {};
  state.paperReading.docs[docId] ??= { seenReplies: [] };
  return state.paperReading.docs[docId];
}

/** 列出批注，并标出「还没处理过」的（增量） */
async function cmdComments(flags, positional) {
  const { config: cfg } = loadConfig();
  const docId = pickDocId(flags, positional, cfg);
  const state = readState();
  const rec = commentState(state, docId);
  const firstTime = !rec.baselinedAt;
  const comments = await listComments(docId);
  const seen = new Set(rec.seenReplies ?? []);
  const baseline = firstTime || Boolean(flags.rebuild);
  const { pending, newlySeen } = pickPending(comments, seen, { baseline });

  if (baseline) {
    rec.seenReplies = [...new Set([...(rec.seenReplies ?? []), ...newlySeen])];
    rec.baselinedAt = new Date().toISOString();
  }
  rec.lastCheck = new Date().toISOString();
  rec.commentCount = comments.length;
  writeState(state);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ docId, baseline, total: comments.length, pending: flags.all ? comments : pending }, null, 2)}\n`,
    );
    return;
  }

  const out = [
    `文档 ${docId} ｜ 批注 ${comments.length} 条 ｜ 待处理 ${pending.length} 条` +
      (baseline ? '（首次检查：已建立基线，历史批注不再重复处理）' : ''),
  ];
  const list = flags.all ? comments : pending;
  if (!list.length) out.push('\n没有待处理的批注。');
  for (const c of list) out.push(`\n${renderComment(c)}`);
  if (pending.length) {
    out.push(
      '\n处理方式：先想好答案，再用下面这条命令回复（会自动记进度、默认标记「已解决」）：',
      `  node ${new URL(import.meta.url).pathname} reply ${docId} <commentId> --text "回答内容"`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/** 回复某条批注（默认同时标记「已解决」） */
async function cmdReply(flags, positional) {
  const { config: cfg } = loadConfig();
  const [rawDoc, commentId] = positional;
  const docId = resolveDocId(rawDoc ?? flags.doc ?? cfg.paperReading?.docId);
  if (!docId) throw new Error('用法: reply <doc|url> <commentId> --text "回答内容"');
  if (!commentId) throw new Error('缺少 commentId（用 comments 命令可以看到）');
  const text = readTextArg(flags.text ?? flags.md);
  if (!text) throw new Error('缺少回复内容：--text "..." 或 --text @文件');

  const replyId = await postReply(docId, commentId, text);
  const solve = flags['no-solve'] !== true && cfg.paperReading?.markSolved !== false;
  if (solve) await setSolved(docId, commentId, true);

  // 记进度：这条批注下的所有回复都算已处理（否则下次触发会重复回复）
  const state = readState();
  const rec = commentState(state, docId);
  const comments = await listComments(docId);
  const thread = comments.find((c) => c.commentId === commentId);
  rec.seenReplies = [
    ...new Set([...(rec.seenReplies ?? []), replyId, ...(thread?.replies ?? []).map((r) => r.replyId)]),
  ];
  rec.lastReplyAt = new Date().toISOString();
  rec.baselinedAt ??= new Date().toISOString();
  writeState(state);

  process.stdout.write(
    `已回复批注 ${commentId}（reply ${replyId}）${solve ? '，并标记为已解决' : ''}；已记入进度，下次不会重复处理。\n`,
  );
}

/** 查论文的「完成单位」（机构/团队）与作者：node cli.mjs affil <id|url> [...] */
async function cmdAffil(flags, positional) {
  if (!positional.length) throw new Error('用法: affil <arxiv-id|url> [更多 id …] [--json]');
  const records = [];
  for (const [i, id] of positional.entries()) {
    const rec = await fetchAffiliation(id);
    records.push(rec);
    if (i + 1 < positional.length) await new Promise((r) => setTimeout(r, Number(flags.gap ?? 1200)));
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  for (const r of records) {
    process.stdout.write(`arXiv:${r.id}\n`);
    process.stdout.write(`  完成单位：${r.institutions.length ? r.institutions.join(' / ') : '未取到（论文没有 HTML 版时拿不到）'}\n`);
    if (r.authors?.length) process.stdout.write(`  作者：${r.authors.join(', ')}\n`);
    if (!r.source && r.note) process.stdout.write(`  备注：${r.note}\n`);
    process.stdout.write('\n');
  }
}

async function cmdDocTree(flags) {
  const { md, docRef, header, entries } = readDocEntries(flags);
  const out = [`来源：${docRef?.url ?? flags.file}`, `简介块 ${header.length} 块 ｜ 简报 ${entries.length} 篇`, ''];
  for (const e of [...entries].sort((a, b) => (tsOf(b) ?? 0) - (tsOf(a) ?? 0))) {
    const sections = e.order.map((k) => k.replace(/^\S+\s*/, '')).join(' / ');
    const first = (e.sections.get(e.order[0]) ?? [])[0] ?? '';
    out.push(`${e.date ?? '????-??-??'} ${e.time || '  --  '}  [${e.order.length} 节] ${sections}`);
    if (first) out.push(`    ${first.slice(0, 90)}`);
  }
  void md;
  process.stdout.write(`${out.join('\n')}\n`);
}

const fmtEntryStamp = (e) => (e ? `${e.date ?? '????-??-??'} ${e.time || '--'}` : null);

async function cmdFixDoc(flags) {
  const { cfg, parts, md, docRef, entries, fixes } = readDocEntries(flags);
  const rendered = renderDoc(entries);
  const backupDir = expandHome(
    typeof flags['backup-dir'] === 'string' ? flags['backup-dir'] : '~/.acp-claw/daily-report/backups',
  );
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(backupDir, `doc-${parts.date}-${stamp}`);
  writeFileSync(`${base}-raw.md`, md, 'utf-8');
  writeFileSync(`${base}-normalized.md`, rendered, 'utf-8');

  const dated = entries.filter((e) => e.date).length;
  const summary = {
    doc: docRef?.url ?? flags.file,
    entries: entries.length,
    dated,
    dropped: fixes.dropped,
    patched: fixes.patched,
    backup: `${base}-raw.md`,
    normalized: `${base}-normalized.md`,
    newest: fmtEntryStamp([...entries].sort((a, b) => (tsOf(b) ?? 0) - (tsOf(a) ?? 0))[0]),
    oldest: fmtEntryStamp([...entries].sort((a, b) => (tsOf(a) ?? 0) - (tsOf(b) ?? 0))[0]),
  };
  if (flags.dry) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, ...summary, note: '未写入文档；规范化结果见 normalized 文件' }, null, 2)}\n`);
    return;
  }
  const layout = docBlocks(docRef);
  const total = layout.blocks.length;
  if (total) deleteDocRange(docRef, 0, total);
  const written = insertDocMarkdown(docRef, rendered, 0);
  process.stdout.write(`${JSON.stringify({ ...summary, deletedBlocks: total, write: written }, null, 2)}\n`);
  void cfg;
}

function cmdConfig() {
  const { config, path, missing } = loadConfig();
  process.stdout.write(
    `${JSON.stringify({ path, missing, dataDir: resolveDataDir(config), config }, null, 2)}\n`,
  );
}

async function cmdNews(flags) {
  const { config: cfg, missing } = loadConfig();
  if (missing) console.error(`⚠️  未找到运行时配置，使用仓库示例配置`);
  const failures = [];
  const news = await collectNews(cfg, failures);
  const brief = renderNews(news, { timeZone: cfg.timezone });
  const dataDir = resolveDataDir(cfg);
  const date = localParts(new Date(), cfg.timezone).date;
  const jsonPath = join(dataDir, `${date}-news.json`);
  const briefPath = join(dataDir, `${date}-news.md`);
  writeFileSync(jsonPath, JSON.stringify(news, null, 2), 'utf-8');
  writeFileSync(briefPath, brief, 'utf-8');
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          jsonPath,
          briefPath,
          count: news.items.length,
          sources: news.sources,
          failures,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${brief}\n`);
    process.stderr.write(`\n[news] 素材已写入 ${briefPath} / ${jsonPath}\n`);
  }
  if (failures.length) process.stderr.write(`[news] 失败项: ${failures.join(' | ')}\n`);
}

async function cmdSchool(flags) {
  const { config: cfg, missing } = loadConfig();
  if (missing) console.error('⚠️  未找到运行时配置，使用仓库示例配置');
  const failures = [];
  const days = typeof flags.days === 'string' ? Number(flags.days) : undefined;
  const school = await collectSchool(cfg, failures, {
    days: Number.isFinite(days) ? days : undefined,
    markSeen: !flags.all,
    fetchDetails: flags['no-detail'] ? false : undefined,
  });
  const parts = localParts(new Date(), cfg.timezone);
  school.stamp = parts.stamp;
  const brief = renderSchool(school, { timeZone: cfg.timezone });
  const dataDir = resolveDataDir(cfg);
  const jsonPath = join(dataDir, `${parts.date}-school.json`);
  const briefPath = join(dataDir, `${parts.date}-school.md`);
  writeFileSync(jsonPath, JSON.stringify(school, null, 2), 'utf-8');
  writeFileSync(briefPath, brief, 'utf-8');
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          jsonPath,
          briefPath,
          summary: school.summary,
          newItems: school.newItems.map((it) => ({
            site: it.site,
            section: it.section,
            date: it.date,
            title: it.title,
            url: it.url,
            tags: it.tags,
            noise: it.noise,
          })),
          sources: school.sources,
          failures,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${brief}\n`);
    process.stderr.write(`\n[school] 素材已写入 ${briefPath} / ${jsonPath}\n`);
  }
  if (failures.length) process.stderr.write(`[school] 失败项: ${failures.join(' | ')}\n`);
}

const COMMANDS = {
  collect: cmdCollect,
  news: cmdNews,
  school: cmdSchool,
  affil: cmdAffil,
  comments: cmdComments,
  reply: cmdReply,
  publish: cmdPublish,
  'doc-tree': cmdDocTree,
  fixdoc: cmdFixDoc,
  config: cmdConfig,
};

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
