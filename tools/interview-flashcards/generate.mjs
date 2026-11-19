#!/usr/bin/env node
// 把面经题目库补全为可导入 ByeByeBaGu 的 Markdown 卡组。
//
// 该脚本不实现前端。它只负责数据胶水：题目修复、答案生成、语义去重、
// 按大模型/Agent、具身智能、AI Infra 分卡组。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { deepseekJSON } from '../daily-report/deepseek-tools.mjs';

const BANK_FILE = process.env.INTERVIEW_BANK_FILE
  || join(homedir(), '.acp-claw', 'daily-report', 'interview-bank.json');
const CACHE_FILE = process.env.INTERVIEW_CARDS_FILE
  || join(homedir(), '.acp-claw', 'daily-report', 'interview-cards.json');
const DEFAULT_OUT = process.env.INTERVIEW_DECKS_DIR
  || join(homedir(), 'career-memory', 'decks');
const CACHE_VERSION = 1;

const DIRECTION_ORDER = ['大模型/Agent', '具身智能', 'AI Infra'];
const TOPIC_ORDER = [
  'Attention/Transformer',
  'LLM基础',
  '预训练',
  'SFT',
  'RL后训练',
  'Agent',
  '多模态',
  '模型压缩',
  '推理Infra',
  '训练Infra',
  'CUDA/编译',
  '具身智能',
  '其他',
];
const INFRA_TOPICS = new Set(['模型压缩', '推理Infra', '训练Infra', 'CUDA/编译']);

function primaryDirectionForTopic(topic, directions) {
  if (topic === '具身智能') return '具身智能';
  if (INFRA_TOPICS.has(topic)) return 'AI Infra';
  if (directions.includes('具身智能') && !directions.includes('大模型/Agent')) return '具身智能';
  return '大模型/Agent';
}

function normalizeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`#>[\]]/g, '')
    .replace(/[\s，。；：、,.!?？（）()/\\-]/g, '');
}

function cacheKey(item) {
  return createHash('sha256')
    .update(`v${CACHE_VERSION}\u0000${item.question}\u0000${(item.directions ?? []).join(',')}`)
    .digest('hex');
}

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function cleanQuestion(value) {
  return String(value ?? '')
    .replace(/^[\s、，,。；;：:]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCard(raw, generated, sourceRows) {
  const question = cleanQuestion(generated.canonical_question ?? generated.question);
  if (!question || generated.skip) return null;
  const sourceCompanies = [...new Set(sourceRows.map((row) => row.company).filter(Boolean))];
  const sourceLinks = sourceRows.map((row) => ({
    company: row.company,
    title: row.sourceTitle,
    url: row.sourceUrl,
  }));
  const directions = [...new Set(sourceRows.flatMap((row) => row.directions ?? []))]
    .filter((direction) => DIRECTION_ORDER.includes(direction));
  return {
    id: `${normalizeKey(question).slice(0, 24)}-${createHash('sha1').update(normalizeKey(question)).digest('hex').slice(0, 8)}`,
    question,
    shortAnswer: String(generated.short_answer ?? '').trim(),
    keyPoints: Array.isArray(generated.key_points)
      ? generated.key_points.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [],
    followups: Array.isArray(generated.followups)
      ? generated.followups.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
      : [],
    pitfalls: Array.isArray(generated.pitfalls)
      ? generated.pitfalls.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
      : [],
    topic: TOPIC_ORDER.includes(generated.topic) ? generated.topic : '其他',
    difficulty: Math.max(1, Math.min(5, Number(generated.difficulty) || 3)),
    directions: directions.length ? directions : ['大模型/Agent'],
    primaryDirection: primaryDirectionForTopic(
      TOPIC_ORDER.includes(generated.topic) ? generated.topic : '其他',
      directions.length ? directions : ['大模型/Agent'],
    ),
    companies: sourceCompanies,
    sources: sourceLinks,
  };
}

async function completeBatch(batch) {
  const system = [
    '你是校招大模型算法和 AI Infra 面试官，负责把面经题点整理成高质量复习卡。',
    '题目可能来自文本抽取，存在缺字、以标点开头、编号断裂或上下文不足。',
    '能明确修复时修复；无法判断原意时 skip=true，绝不强行编题。',
    '答案必须技术准确、用于口述面试；不要写空话，不要伪造论文或公司信息。',
    '返回严格 JSON，格式：{"cards":[{"source_id":"...","skip":false,"canonical_question":"...","short_answer":"...","key_points":["..."],"followups":["..."],"pitfalls":["..."],"topic":"...","difficulty":1}]}',
    `topic 只能取：${TOPIC_ORDER.join('、')}。`,
    'difficulty 1-5。short_answer 用 80-180 个中文字符，key_points 3-6 条。',
  ].join('\n');
  const payload = batch.map((item) => ({
    source_id: item.id,
    question: item.question,
    directions: item.directions,
    companies: item.companies,
    source_title: item.sourceTitle,
  }));
  const { data } = await deepseekJSON({
    system,
    user: JSON.stringify({ items: payload }),
    model: process.env.INTERVIEW_CARD_MODEL || 'deepseek-flash',
    maxTokens: 8192,
  });
  return Array.isArray(data?.cards) ? data.cards : [];
}

function sourceRowsFromBank(bank) {
  return (bank.questions ?? []).map((item, index) => ({
    ...item,
    rawIndex: index,
    sourceTitle: item.sourceTitle || '面经原帖',
  }));
}

function markdownAnswer(card) {
  const lines = [
    '**30 秒回答**',
    '',
    card.shortAnswer,
    '',
    '**关键点**',
    '',
    ...card.keyPoints.map((item) => `• ${item}`),
  ];
  if (card.followups.length) {
    lines.push('', '**常见追问**', '', ...card.followups.map((item) => `• ${item}`));
  }
  if (card.pitfalls.length) {
    lines.push('', '**易错点**', '', ...card.pitfalls.map((item) => `• ${item}`));
  }
  const sources = [];
  const seen = new Set();
  for (const source of card.sources) {
    const key = source.url || source.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sources.push(`• ${source.company || '面经'}：[${source.title}](${source.url})`);
  }
  if (sources.length) lines.push('', '**来源**', '', ...sources);
  lines.push('', '> 答案由 AI 基于题目整理，建议结合原帖和权威资料复核。');
  return lines.join('\n');
}

function renderDeck(cards, direction) {
  const out = [`# ${direction}`, ''];
  for (const topic of TOPIC_ORDER) {
    const group = cards
      .filter((card) => card.directions.includes(direction) && card.topic === topic)
      .sort((a, b) => a.question.localeCompare(b.question, 'zh-CN'));
    if (!group.length) continue;
    out.push(`## ${topic}`, '');
    for (const card of group) {
      out.push(`### ${card.question}`, '', markdownAnswer(card), '');
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

function dedupeCards(cards) {
  const byQuestion = new Map();
  for (const card of cards) {
    const key = normalizeKey(card.question);
    const previous = byQuestion.get(key);
    if (!previous) {
      byQuestion.set(key, card);
      continue;
    }
    previous.companies = [...new Set([...previous.companies, ...card.companies])];
    previous.directions = [...new Set([...previous.directions, ...card.directions])];
    const seen = new Set(previous.sources.map((x) => x.url || x.title));
    for (const source of card.sources) {
      const sourceKey = source.url || source.title;
      if (!seen.has(sourceKey)) {
        previous.sources.push(source);
        seen.add(sourceKey);
      }
    }
    if (card.keyPoints.length > previous.keyPoints.length) previous.keyPoints = card.keyPoints;
    if (card.followups.length > previous.followups.length) previous.followups = card.followups;
    if (card.pitfalls.length > previous.pitfalls.length) previous.pitfalls = card.pitfalls;
  }
  return [...byQuestion.values()];
}

export async function generateDecks({
  bankFile = BANK_FILE,
  cacheFile = CACHE_FILE,
  outDir = DEFAULT_OUT,
  batchSize = 6,
  log = () => {},
} = {}) {
  const bank = loadJSON(bankFile, { questions: [] });
  const cache = loadJSON(cacheFile, { version: CACHE_VERSION, cards: {} });
  if (cache.version !== CACHE_VERSION) cache.cards = {};
  cache.version = CACHE_VERSION;

  const sourceRows = sourceRowsFromBank(bank);
  const pending = [];
  for (const item of sourceRows) {
    const key = cacheKey(item);
    if (!cache.cards[key]) pending.push({ ...item, cacheKey: key });
  }

  log(`题目 ${sourceRows.length} 条，已有缓存 ${sourceRows.length - pending.length} 条，待生成 ${pending.length} 条`);
  let generatedBatches = 0;
  for (const batch of chunks(pending, batchSize)) {
    const results = await completeBatch(batch);
    const bySource = new Map(results.map((row) => [String(row.source_id ?? ''), row]));
    for (const input of batch) {
      const generated = bySource.get(input.id) ?? { skip: true, reason: '模型未返回' };
      cache.cards[input.cacheKey] = generated;
    }
    generatedBatches += 1;
    log(`已生成 ${generatedBatches}/${Math.ceil(pending.length / batchSize)} 批`);
    saveJSON(cacheFile, cache);
  }

  const generatedCards = [];
  for (const item of sourceRows) {
    const generated = cache.cards[cacheKey(item)];
    if (!generated) continue;
    const card = normalizeCard(item, generated, [item]);
    if (card) generatedCards.push(card);
  }
  const cards = dedupeCards(generatedCards);

  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const direction of DIRECTION_ORDER) {
    const directionCards = cards.filter((card) => card.primaryDirection === direction);
    if (!directionCards.length) continue;
    const filename = `${direction.replaceAll('/', '-')}.md`;
    const path = join(outDir, filename);
    writeFileSync(path, renderDeck(directionCards, direction), 'utf8');
    files.push({ direction, path, cards: directionCards.length });
  }
  saveJSON(join(outDir, 'cards.json'), { generatedAt: new Date().toISOString(), cards });
  return { bankQuestions: sourceRows.length, pending: pending.length, cards, files };
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const flags = parseArgs(process.argv.slice(2));
  const result = await generateDecks({
    bankFile: flags.bank || BANK_FILE,
    cacheFile: flags.cache || CACHE_FILE,
    outDir: flags.out || DEFAULT_OUT,
    batchSize: Number(flags['batch-size'] ?? 6),
    log: (message) => process.stderr.write(`[interview-cards] ${message}\n`),
  });
  process.stdout.write(`${JSON.stringify({
    bankQuestions: result.bankQuestions,
    pending: result.pending,
    cards: result.cards.length,
    files: result.files,
  }, null, 2)}\n`);
}
