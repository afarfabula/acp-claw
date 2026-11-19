// 小红书技术实习机会：筛选 base 成都或正文明确支持远程的 LLM/Agent、具身智能、AI Infra 岗位。
//
// 该脚本复用服务器上已登录的小红书 Chrome，不绕过验证码或平台风控。搜索和帖子详情都通过
// 正常页面导航完成；某个查询失败时会继续处理其他查询，最终只推送筛选后的岗位摘要。

import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readState, writeState } from './state.mjs';

const CHROME_ENDPOINT = process.env.JOBS_XHS_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const WEBHOOK_FILE = process.env.JOBS_WEBHOOK_FILE
  || join(homedir(), '.acp-claw', 'daily-report', 'jobs-webhook.env');
const INTERVIEW_BANK_FILE = process.env.INTERVIEW_BANK_FILE
  || join(homedir(), '.acp-claw', 'daily-report', 'interview-bank.json');
const LARK_CLI = process.env.LARK_CLI
  || '/home_ext/quyanyi/.local/node/lib/node_modules/@larksuite/cli/bin/lark-cli';

export const DEFAULT_XHS_QUERIES = [
  '字节 实习',
  '腾讯 实习',
  '京东 实习',
  '阿里 实习',
  '商汤 实习',
  'OPPO 实习',
  '远程 大模型 Agent 实习',
  '远程 具身智能 实习',
  '远程 AI Infra 推理 实习',
];

export const DEFAULT_INTERVIEW_QUERIES = [
  '字节 大模型 实习 面经',
  '腾讯 大模型 实习 面经',
  '京东 大模型 实习 面经',
  '阿里 大模型 实习 面经',
  '商汤 算法 实习 面经',
  'OPPO 算法 实习 面经',
];

export const BIG_COMPANIES = [
  { name: '字节跳动', re: /字节|抖音|ByteDance/i },
  { name: '腾讯', re: /腾讯|Tencent|微信|混元/i },
  { name: '京东', re: /京东|JD\.?com/i },
  { name: '阿里巴巴', re: /阿里巴巴|阿里云|阿里|Alibaba|蚂蚁|通义/i },
  { name: '商汤', re: /商汤|SenseTime/i },
  { name: 'OPPO', re: /OPPO|欧珀/i },
];

const JOB_RE = /(实习|intern(?:ship)?|招聘|招人|招募|职位|岗位|同事|加入我们|hiring|join\s*us)/i;
const INTERVIEW_RE = /(面经|面试|八股|凉经|一面|二面|三面|HR面|内推面|手撕|算法题)/i;
const REMOTE_RE = /(完全远程|全程远程|支持\s*(?:remote|远程)|可\s*remote|可远程|远程(?:办公|实习|工作|协作|招聘)?|线上实习|不限城市|地点不限|工作地点不限|不用通勤)/i;
const REMOTE_NEGATIVE_RE = /(?:不接受|不支持|暂不支持|无法)(?:远程|线上)|仅限?(?:线下|到岗)|必须(?:线下|到岗)/i;
const CHENGDU_RE = /(?:成都|四川)/i;
const EXPIRED_RE = /(已招满|已招到|人已敲定|人选已敲定|已停止招聘|暂停接收简历|停止接收简历|岗位关闭|招聘结束)/i;
const SEEKER_RE = /(求助|请问|求痛批|求职|有没有人收留|怎么找|想投在|能不能做|有没有成都的老板|在小红书能找到实习吗|有什么(?:infra|ai\s*infra|具身|大模型|agent).{0,8}岗位吗|求\s*(?:ai\s*infra|大模型|agent|具身|远程)?\s*实习|找(?:个|一份)?实习)/i;
const TRAINING_RE = /(培训|训练营|学员|城市主理人|本地合作方)/i;
const RESALE_RE = /(出售.*(?:api\s*key|账号|密钥)|倒卖|代充|刷单)/i;
const DATA_COLLECTION_RE = /(数据采集|采集员|数据标注|标注员|真机实践点|机械臂操作采集)/i;
const TECH_ROLE_RE = /(算法|研发|开发|工程|技术|研究|科研|实习|intern|research|scientist|engineer|infra|编程|代码|训练|推理|部署|算子|模型)/i;
const NON_TECH_ROLE_RE = /(运营|招聘助理|招聘专员|商务|销售|市场|内容|编导|设计|摄影|剪辑|主播|客服|助理|猎头|资源对接|产品经理|产品运营|产品助理|产品实习|增长|BD|行政|人力资源|法务|财务)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SALARY_RE = /(?:薪资|补贴|报酬|日薪|时薪)[^\n。]{0,35}|(?:\d+\s*[-–—~至]\s*\d+\s*元?\s*\/\s*天)|(?:\d+\s*元?\s*\/\s*天)|(?:薪资面议|面议)/i;
const PROFILE_RE = /(Agent|LLM|大模型|多模态|VLM|VLA|视觉\s*token|token\s*压缩|模型压缩|量化|QAT|PTQ|强化学习|GRPO|DPO|SFT|RL|vLLM|SGLang|TensorRT|Megatron|CUDA|Triton|Profiling|推理优化|分布式训练|MoE)/gi;

const TARGET_DIRECTIONS = [
  {
    name: '大模型/Agent',
    re: /(大模型|大语言模型|\bLLM\b|Agent|智能体|多模态|VLM|VLA|自然语言处理|NLP|预训练|后训练|强化学习|RLHF|GRPO|DPO|SFT|对齐|推理能力|长上下文|MoE|RAG|工具调用|Prompt)/i,
  },
  {
    name: '具身智能',
    re: /(具身|机器人|机械臂|VLA|运动规划|机器人操作|机器人学习|sim2real|仿真环境|物理引擎|三维重建|SLAM|Embodied)/i,
  },
  {
    name: 'AI Infra',
    re: /(AI\s*Infra|推理优化|推理框架|推理引擎|推理加速|模型部署|模型压缩|量化|低比特|QAT|PTQ|vLLM|SGLang|TensorRT|Megatron|CUDA|CUPTI|Triton|Kernel|Serving|分布式训练|算子|KV\s*Cache|显存|Profiling|性能分析|异构|并行训练)/i,
  },
];

export function detectDirections(text) {
  const blob = String(text ?? '');
  return TARGET_DIRECTIONS.filter((direction) => direction.re.test(blob)).map((direction) => direction.name);
}

export function detectBigCompany(text) {
  const blob = String(text ?? '');
  const index = BIG_COMPANIES.findIndex((company) => company.re.test(blob));
  return index >= 0 ? { name: BIG_COMPANIES[index].name, index } : null;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stripMarkup(value) {
  return String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function datePartsToMs(parts) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    12,
  );
}

/** 把小红书常见的“5天前 / 昨天 / 11-10”时间文本归一成 YYYY-MM-DD。 */
export function parseNoteDate(value, now = new Date()) {
  const text = cleanText(value);
  if (!text) return '';

  const full = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;

  if (/今天/.test(text)) return now.toISOString().slice(0, 10);
  if (/昨天/.test(text)) {
    return new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
  }

  const relative = text.match(/(\d+)\s*(分钟|小时|天)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === '分钟'
      ? 60_000
      : relative[2] === '小时' ? 3600_000 : 86400_000;
    return new Date(now.getTime() - amount * unitMs).toISOString().slice(0, 10);
  }

  const short = text.match(/(?:^|\D)(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (short) {
    const month = String(short[1]).padStart(2, '0');
    const day = String(short[2]).padStart(2, '0');
    let year = now.getUTCFullYear();
    const candidate = datePartsToMs({ year, month, day });
    if (candidate > now.getTime() + 2 * 86400_000) year -= 1;
    return `${year}-${month}-${day}`;
  }
  return '';
}

export function daysSince(dateText, now = new Date()) {
  const time = Date.parse(`${dateText}T12:00:00+08:00`);
  if (!Number.isFinite(time)) return Infinity;
  return Math.max(0, Math.floor((now.getTime() - time) / 86400_000));
}

export function classifyOpportunity(note, { now = new Date(), maxAgeDays = 30 } = {}) {
  const title = stripMarkup(note.title);
  const desc = stripMarkup(note.desc);
  const blob = `${title}\n${desc}`;
  if (!JOB_RE.test(blob)) return { include: false, reason: '不是招聘/实习帖' };
  if (EXPIRED_RE.test(blob)) return { include: false, reason: '帖子已招满或停止招聘' };
  if (SEEKER_RE.test(title) || SEEKER_RE.test(desc.slice(0, 300))) {
    return { include: false, reason: '求职者求助帖，不是招聘帖' };
  }
  if (TRAINING_RE.test(title) || RESALE_RE.test(blob)) {
    return { include: false, reason: '培训/资源转售信息，不是实习岗位' };
  }
  if (DATA_COLLECTION_RE.test(blob) && !/(算法|研发|开发|工程|研究|infra|编译|算子|推理)/i.test(blob)) {
    return { include: false, reason: '数据采集/标注类任务，不是技术研发实习' };
  }
  if (NON_TECH_ROLE_RE.test(title) && !/(研发|开发|算法|工程|技术)/.test(title)) {
    return { include: false, reason: '非技术岗位' };
  }
  if (!TECH_ROLE_RE.test(`${title}\n${desc.slice(0, 800)}`)) {
    return { include: false, reason: '缺少技术研发岗位证据' };
  }
  const directions = detectDirections(blob);
  if (!directions.length) {
    return { include: false, reason: '不属于大模型/Agent、具身智能或 AI Infra' };
  }

  const date = parseNoteDate(note.dateText || note.cardDate || '', now);
  if (date && daysSince(date, now) > maxAgeDays) {
    return { include: false, reason: `超过 ${maxAgeDays} 天` };
  }

  const chengdu = CHENGDU_RE.test(blob);
  const remote = REMOTE_RE.test(blob) && !REMOTE_NEGATIVE_RE.test(blob);
  if (!chengdu && !remote) return { include: false, reason: '不是 base 成都，也未明确远程' };
  const company = detectBigCompany(title)
    || detectBigCompany(note.author ?? '')
    || detectBigCompany(desc);

  return {
    include: true,
    reason: '',
    category: chengdu ? 'chengdu' : 'remote',
    chengdu,
    remote,
    technical: true,
    directions,
    profileHits: (blob.match(PROFILE_RE) ?? []).length,
    company: company?.name ?? '',
    companyRank: company?.index ?? -1,
    date,
    salary: desc.match(SALARY_RE)?.[0]?.trim() || '',
    email: desc.match(EMAIL_RE)?.[0] || '',
    title,
    desc,
  };
}

const QUESTION_RE = /(什么是|如何|为什么|区别|原理|讲讲|介绍一下|手撕|代码题|算法题|八股|考点|问了|考察|实现|优化|设计|推导|公式|复杂度|项目|论文|实验)/i;
const QUESTION_SKIP_RE = /(投递|简历|工作地点|base|薪资|福利|私信|微信|邮箱|二维码|转发|关注|点赞|收藏|发布于|编辑于)/i;
const INTERVIEW_UNWANTED_RE = /(面试辅导|面试培训|付费内推|保offer|求职机构|mock辅导)/i;

function normalizeQuestion(text) {
  return cleanText(
    String(text ?? '')
      .replace(/^[-*•·\d（(一二三四五六七八九十]+[.)、）\s]*/, '')
      .replace(/#[^\s#]+/g, '')
      .replace(/^Q\d*[:：\s]*/i, ''),
  );
}

export function extractInterviewQuestions(desc, limit = 12) {
  const chunks = stripMarkup(desc)
    .split(/\n+/)
    .flatMap((line) => line.length > 320 ? line.split(/(?<=[。！？?])/) : [line])
    .map(normalizeQuestion)
    .filter((line) =>
      line.length >= 8
      && line.length <= 320
      && !QUESTION_SKIP_RE.test(line)
      && !/^#/.test(line)
      && (QUESTION_RE.test(line) || /[?？]/.test(line)),
    );
  const seen = new Set();
  const out = [];
  for (const line of chunks) {
    const key = line.toLowerCase().replace(/[\s，。；：、,.!?？！]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export function classifyInterview(note, { now = new Date(), maxAgeDays = 180 } = {}) {
  const title = stripMarkup(note.title);
  const desc = stripMarkup(note.desc);
  const blob = `${title}\n${desc}\n${note.author ?? ''}`;
  if (!INTERVIEW_RE.test(blob)) return { include: false, reason: '不是面经/面试帖' };
  if (INTERVIEW_UNWANTED_RE.test(blob)) return { include: false, reason: '面试培训机构内容' };
  const company = detectBigCompany(title)
    || detectBigCompany(note.author ?? '')
    || detectBigCompany(desc);
  if (!company) return { include: false, reason: '不是指定大厂面经' };
  const directions = detectDirections(blob);
  if (!directions.length) {
    return { include: false, reason: '不属于大模型/Agent、具身智能或 AI Infra' };
  }
  const date = parseNoteDate(note.dateText || note.cardDate || '', now);
  if (date && daysSince(date, now) > maxAgeDays) {
    return { include: false, reason: `超过 ${maxAgeDays} 天` };
  }
  const questions = extractInterviewQuestions(desc);
  if (!questions.length) return { include: false, reason: '没有可抽取的文字题目' };
  return {
    include: true,
    reason: '',
    title,
    desc,
    company: company.name,
    companyRank: company.index,
    directions,
    date,
    questions,
  };
}

function dedupeKey(note) {
  return note.noteId || note.url || `${note.title}\u0000${note.author}`;
}

export function dedupeNotes(notes) {
  const byKey = new Map();
  for (const note of notes) {
    const key = dedupeKey(note);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || String(note.desc ?? '').length > String(previous.desc ?? '').length) {
      byKey.set(key, note);
    }
  }
  return [...byKey.values()];
}

function shortSummary(text, max = 220) {
  const plain = stripMarkup(text)
    .replace(/#[^\s#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function renderJobsPushMessage(notes, {
  now = new Date(),
  hiddenCount = 0,
  interviewQuestions = [],
  interviewBankUrl = '',
} = {}) {
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const lines = [
    '💼 大厂优先技术实习 & 面经考点',
    `更新时间：${stamp}`,
    '岗位：base 成都优先大厂，remote 不限城市；只看大模型/Agent、具身智能、AI Infra',
    '',
  ];
  for (const [category, label] of [['chengdu', '📍 成都'], ['remote', '🌐 Remote']]) {
    const group = notes.filter((note) => note.category === category);
    if (!group.length) continue;
    lines.push(label);
    group.forEach((note, index) => {
      const meta = [
        note.company || '',
        note.directions.join(' / '),
        note.remote && category === 'chengdu' ? '支持远程' : '',
        note.salary,
      ].filter(Boolean).join(' · ');
      lines.push(`${index + 1}. ${note.title}`);
      if (meta) lines.push(`   ${meta}`);
      lines.push(`   ${shortSummary(note.desc)}`);
      if (note.email) lines.push(`   投递：${note.email}`);
      else lines.push('   投递：查看原帖私信/评论区');
      lines.push(`   原帖：${note.url}`);
    });
    lines.push('');
  }
  if (hiddenCount > 0) {
    lines.push(`另有 ${hiddenCount} 条符合条件，已留到下一轮或岗位网页查看。`);
  }
  if (interviewQuestions.length) {
    lines.push('📚 新增大厂面经考点');
    interviewQuestions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.company}｜${item.directions.join(' / ')}：${item.question}`);
      lines.push(`   来源：${item.sourceTitle} ${item.sourceUrl}`);
    });
    if (interviewBankUrl) lines.push(`完整题库：${interviewBankUrl}`);
    lines.push('');
  }
  lines.push('岗位来自小红书招聘帖，仅保留目标技术方向；投递前请再次确认公司、薪资与在招状态。');
  return lines.join('\n').trim();
}

export function loadInterviewBank(path = INTERVIEW_BANK_FILE) {
  if (!existsSync(path)) {
    return { version: 1, docUrl: '', posts: {}, questions: [], updatedAt: null };
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return {
    version: 1,
    docUrl: String(data.docUrl ?? ''),
    posts: data.posts ?? {},
    questions: Array.isArray(data.questions) ? data.questions : [],
    updatedAt: data.updatedAt ?? null,
  };
}

function saveInterviewBank(bank, path = INTERVIEW_BANK_FILE) {
  writeFileSync(path, `${JSON.stringify(bank, null, 2)}\n`, 'utf8');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function questionKey(noteId, question) {
  return `${noteId}:${question.toLowerCase().replace(/[\s，。；：、,.!?？（）()]/g, '')}`;
}

export function mergeInterviewQuestions(bank, notes, now = new Date()) {
  const existing = new Set(bank.questions.map((item) => item.id));
  const newQuestions = [];
  for (const note of notes) {
    for (const question of note.questions) {
      const id = questionKey(note.noteId, question);
      if (existing.has(id)) continue;
      const item = {
        id,
        company: note.company,
        companyRank: note.companyRank,
        directions: note.directions,
        question,
        sourceTitle: note.title,
        sourceUrl: note.url,
        date: note.date,
        addedAt: now.toISOString(),
      };
      existing.add(id);
      bank.questions.push(item);
      newQuestions.push(item);
    }
    bank.posts[note.noteId] = {
      company: note.company,
      title: note.title,
      url: note.url,
      date: note.date,
      directions: note.directions,
      questionCount: note.questions.length,
      lastSeenAt: now.toISOString(),
    };
  }
  bank.updatedAt = now.toISOString();
  return newQuestions;
}

export function pickQuestionHighlights(questions, limit = 10) {
  const perSource = new Map();
  const perCompany = new Map();
  const selected = [];

  const tryTake = (item, sourceLimit, companyLimit) => {
    if (selected.length >= limit) return false;
    const sourceCount = perSource.get(item.sourceUrl) ?? 0;
    const companyCount = perCompany.get(item.company) ?? 0;
    if (sourceCount >= sourceLimit || companyCount >= companyLimit) return false;
    selected.push(item);
    perSource.set(item.sourceUrl, sourceCount + 1);
    perCompany.set(item.company, companyCount + 1);
    return true;
  };

  // 先保证每家公司都有曝光，再从同一来源补第二条。
  for (const company of BIG_COMPANIES) {
    const item = questions.find((candidate) => candidate.company === company.name);
    if (item) tryTake(item, 2, 3);
  }
  for (const item of questions) tryTake(item, 2, 3);
  for (const item of questions) tryTake(item, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  return selected;
}

function runLarkCli(args, input) {
  const result = spawnSync(LARK_CLI, args, {
    input,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`lark-cli 失败：${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
  const output = String(result.stdout ?? '').trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`lark-cli 返回非 JSON：${output.slice(0, 500)}`);
  }
}

function ensureInterviewBankDoc(bank) {
  if (bank.docUrl) return bank.docUrl;
  const result = runLarkCli([
    'docs', '+create',
    '--title', '大厂 AI 技术实习面经题库',
    '--as', 'user',
  ]);
  if (!result.ok || !result.data?.document?.url) {
    throw new Error('创建面经题库文档失败');
  }
  bank.docUrl = result.data.document.url;
  return bank.docUrl;
}

function renderInterviewBankXml(questions, { now, firstRun }) {
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const out = [];
  if (firstRun) {
    out.push('<h1>大厂 AI 技术实习面经题库</h1>');
    out.push('<p>自动整理小红书公开面经，按公司和方向归类。题目保留原帖链接，建议投递前回看原帖确认岗位、轮次和时效。</p>');
  }
  out.push(`<h2>${escapeXml(stamp)} 更新</h2>`);
  for (const company of BIG_COMPANIES) {
    const companyItems = questions.filter((item) => item.company === company.name);
    if (!companyItems.length) continue;
    out.push(`<h3>${escapeXml(company.name)}</h3>`);
    for (const direction of TARGET_DIRECTIONS) {
      const items = companyItems.filter((item) => item.directions.includes(direction.name));
      if (!items.length) continue;
      out.push(`<h4>${escapeXml(direction.name)}</h4>`);
      out.push('<ul>');
      for (const item of items) {
        out.push(
          `<li>${escapeXml(item.question)} <a href="${escapeXml(item.sourceUrl)}">原帖</a></li>`,
        );
      }
      out.push('</ul>');
    }
  }
  return out.join('\n');
}

function appendQuestionsToBankDoc(bank, questions, { now, firstRun }) {
  const docUrl = ensureInterviewBankDoc(bank);
  if (!questions.length) return docUrl;
  const xml = renderInterviewBankXml(questions, { now, firstRun });
  const result = runLarkCli([
    'docs', '+update',
    '--doc', docUrl,
    '--as', 'user',
    '--command', 'append',
    '--content', '-',
  ], xml);
  if (!result.ok) throw new Error('面经题库写入失败');
  return docUrl;
}

function getWebhookUrl() {
  if (process.env.JOBS_WEBHOOK_URL) return process.env.JOBS_WEBHOOK_URL.trim();
  if (!existsSync(WEBHOOK_FILE)) {
    throw new Error(`缺少 Webhook 配置：${WEBHOOK_FILE}`);
  }
  const text = readFileSync(WEBHOOK_FILE, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?JOBS_WEBHOOK_URL\s*=\s*(.+?)\s*$/);
    if (match) return match[1].replace(/^['"]|['"]$/g, '').trim();
  }
  throw new Error('Webhook 配置中没有 JOBS_WEBHOOK_URL');
}

export async function sendFeishuWebhook(text, { webhookUrl } = {}) {
  const url = webhookUrl || getWebhookUrl();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Webhook 返回非 JSON：${body.slice(0, 160)}`);
  }
  const code = data.code ?? data.StatusCode ?? data.status_code;
  if (code !== undefined && Number(code) !== 0) {
    throw new Error(`Webhook 失败：${data.msg || data.StatusMessage || data.status_message || body.slice(0, 160)}`);
  }
  return data;
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function createAutomationTab() {
  const res = await fetch(`${CHROME_ENDPOINT}/json/new?about%3Ablank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`无法创建浏览器标签页：HTTP ${res.status}`);
  return res.json();
}

async function closeAutomationTab(id) {
  await fetch(`${CHROME_ENDPOINT}/json/close/${encodeURIComponent(id)}`).catch(() => {});
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

const EXTRACT_CARDS_JS = `JSON.stringify([...document.querySelectorAll("section.note-item")].map((section) => {
  const anchor = section.querySelector('a[href*="/search_result/"]');
  const lines = (section.innerText || "").split("\\n").map((x) => x.trim()).filter(Boolean);
  return {
    title: lines[0] || "",
    text: lines.join("\\n"),
    href: anchor?.href || "",
    cardDate: lines.find((x) => /(\\d+小时前|\\d+天前|昨天|今天|\\d{1,2}-\\d{1,2}|20\\d{2}-\\d{2}-\\d{2})/.test(x)) || "",
  };
}).filter((x) => x.href))`;

const EXTRACT_DETAIL_JS = `JSON.stringify({
  title: document.querySelector("#detail-title")?.innerText || document.title || "",
  desc: document.querySelector("#detail-desc")?.innerText || "",
  container: (document.querySelector("#noteContainer")?.innerText || "").slice(0, 7000),
  url: location.href,
  body: (document.body?.innerText || "").slice(0, 1200)
})`;

function noteIdFromUrl(url) {
  return String(url ?? '').match(/\/(?:explore|search_result)\/([0-9a-f]{24})/i)?.[1] || '';
}

function detailDate(container, fallback) {
  const lines = String(container ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const match = lines.find((line) =>
    /^(?:编辑于\s*)?(?:今天|昨天|\d+\s*(?:分钟|小时|天)前|\d{1,2}-\d{1,2}(?:\s+\d{2}:\d{2})?|20\d{2}-\d{2}-\d{2})/.test(line),
  );
  return match || fallback || '';
}

function detailAuthor(container) {
  return String(container ?? '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
}

async function collectSearchCandidates(cdp, queries, {
  waitMs,
  log,
  marker = JOB_RE,
  perQuery = 4,
}) {
  const byQuery = [];
  const failures = [];
  for (const query of queries) {
    try {
      log(`搜索：${query}`);
      await cdp.call('Page.navigate', {
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`,
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const raw = await evaluate(cdp, EXTRACT_CARDS_JS);
      const cards = JSON.parse(raw || '[]');
      const body = await evaluate(cdp, 'document.body?.innerText || ""');
      if (/登录后查看搜索结果/.test(body)) throw new Error('小红书登录态已失效');
      if (/website-login\/error|Account exception|安全限制/i.test(body)) {
        throw new Error('小红书账号触发安全限制');
      }
      const picked = cards
        .filter((card) => marker.test(`${card.title}\n${card.text}`))
        .slice(0, perQuery)
        .map((card) => ({ ...card, noteId: noteIdFromUrl(card.href), query }));
      byQuery.push(picked);
    } catch (error) {
      failures.push(`${query}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 轮询各查询的前几条，避免详情读取预算全部被第一个“成都”查询占掉。
  const interleaved = [];
  for (let rank = 0; rank < perQuery; rank += 1) {
    for (const list of byQuery) {
      if (list[rank]) interleaved.push(list[rank]);
    }
  }
  return { candidates: dedupeNotes(interleaved), failures };
}

async function collectDetails(cdp, candidates, {
  waitMs,
  now,
  maxDetails,
  log,
  classifier = classifyOpportunity,
}) {
  const notes = [];
  const failures = [];
  for (const candidate of candidates.slice(0, maxDetails)) {
    try {
      log(`读取：${candidate.title}`);
      await cdp.call('Page.navigate', {
        url: candidate.href.replace(/xsec_source=$/, 'xsec_source=pc_search'),
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const raw = await evaluate(cdp, EXTRACT_DETAIL_JS);
      const detail = JSON.parse(raw || '{}');
      if (/登录后查看搜索结果/.test(detail.body || '')) throw new Error('小红书登录态已失效');
      if (/website-login\/error|Account exception|安全限制/i.test(detail.body || '')) {
        throw new Error('小红书账号触发安全限制');
      }
      const note = {
        noteId: candidate.noteId,
        title: stripMarkup(detail.title || candidate.title),
        desc: stripMarkup(detail.desc || ''),
        author: detailAuthor(detail.container),
        dateText: detailDate(detail.container, candidate.cardDate),
        url: detail.url || candidate.href,
        query: candidate.query,
      };
      const classification = classifier(note, { now });
      if (classification.include) notes.push({ ...note, ...classification });
    } catch (error) {
      failures.push(`${candidate.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { notes, failures };
}

function noteScore(note) {
  return (note.companyRank >= 0 ? 500 - note.companyRank * 10 : 0)
    + (note.directions?.length ?? 0) * 30
    + Math.min(80, (note.profileHits ?? 0) * 10)
    + (note.category === 'chengdu' ? 30 : 20)
    + Math.max(0, 30 - daysSince(note.date));
}

export async function runJobsXhsPush(cfg, {
  all = false,
  dryRun = false,
  maxAgeDays = 30,
  maxDetails = 36,
  maxPushItems = 10,
  interviewMaxAgeDays = 365,
  interviewMaxDetails = 12,
  maxQuestionsPush = 10,
  queries = DEFAULT_XHS_QUERIES,
  interviewQueries = DEFAULT_INTERVIEW_QUERIES,
  searchWaitMs = 3500,
  detailWaitMs = 2600,
  bankPath = INTERVIEW_BANK_FILE,
  cdp,
  log = () => {},
} = {}) {
  if (!cdp) throw new Error('缺少浏览器 CDP 连接');
  const now = new Date();

  log('搜索大厂与技术方向实习');
  const search = await collectSearchCandidates(cdp, queries, { waitMs: searchWaitMs, log });
  const authFailure = search.failures.find((failure) =>
    /登录态|安全限制|Account exception|website-login/i.test(failure),
  );
  if (authFailure) throw new Error(authFailure);
  const detail = await collectDetails(cdp, search.candidates, {
    waitMs: detailWaitMs,
    now,
    maxDetails,
    log,
  });
  const notes = dedupeNotes(detail.notes).sort(
    (a, b) => noteScore(b) - noteScore(a) || String(b.date).localeCompare(String(a.date)),
  );

  log('搜索大厂技术面经');
  const interviewSearch = await collectSearchCandidates(cdp, interviewQueries, {
    waitMs: searchWaitMs,
    log,
    marker: INTERVIEW_RE,
    perQuery: 4,
  });
  const interviewAuthFailure = interviewSearch.failures.find((failure) =>
    /登录态|安全限制|Account exception|website-login/i.test(failure),
  );
  if (interviewAuthFailure) throw new Error(interviewAuthFailure);
  const interviewDetail = await collectDetails(cdp, interviewSearch.candidates, {
    waitMs: detailWaitMs,
    now,
    maxDetails: interviewMaxDetails,
    log,
    classifier: (note, options) => classifyInterview(note, {
      ...options,
      maxAgeDays: interviewMaxAgeDays,
    }),
  });
  const interviewNotes = dedupeNotes(interviewDetail.notes).sort(
    (a, b) =>
      (a.companyRank ?? 99) - (b.companyRank ?? 99)
      || String(b.date).localeCompare(String(a.date)),
  );

  const bank = loadInterviewBank(bankPath);
  const oldQuestionCount = bank.questions.length;
  const newQuestions = mergeInterviewQuestions(bank, interviewNotes, now);

  const state = readState();
  const pushState = (state.jobs ??= {}).xhsPush ??= {};
  pushState.seen ??= {};
  const initialized = Boolean(pushState.initializedAt);
  const unseen = all || !initialized
    ? notes
    : notes.filter((note) => !pushState.seen[note.noteId]);
  const selected = unseen.slice(0, maxPushItems);
  const hiddenCount = Math.max(0, unseen.length - selected.length);
  const selectedQuestions = pickQuestionHighlights(newQuestions, maxQuestionsPush);
  let bankDocUrl = bank.docUrl;
  if (!dryRun && newQuestions.length) {
    bankDocUrl = appendQuestionsToBankDoc(bank, newQuestions, {
      now,
      firstRun: oldQuestionCount === 0 && !bank.docUrl,
    });
  }
  const message = selected.length || selectedQuestions.length
    ? renderJobsPushMessage(selected, {
      now,
      hiddenCount,
      interviewQuestions: selectedQuestions,
      interviewBankUrl: bankDocUrl,
    })
    : '';

  let sent = false;
  if (message && !dryRun) {
    await sendFeishuWebhook(message);
    sent = true;
    if (selectedQuestions.length) saveInterviewBank(bank, bankPath);
    for (const note of selected) pushState.seen[note.noteId] = now.toISOString();
    pushState.initializedAt ||= now.toISOString();
    pushState.lastSentAt = now.toISOString();
    pushState.lastCount = selected.length;
    const cutoff = now.getTime() - 90 * 86400_000;
    for (const [id, stamp] of Object.entries(pushState.seen)) {
      if (Date.parse(stamp) < cutoff) delete pushState.seen[id];
    }
    writeState(state);
  }

  return {
    sent,
    dryRun,
    initialized,
    searched: search.candidates.length,
    checked: Math.min(search.candidates.length, maxDetails),
    matched: notes.length,
    selected: selected.length,
    hidden: hiddenCount,
    interviewSearched: interviewSearch.candidates.length,
    interviewChecked: Math.min(interviewSearch.candidates.length, interviewMaxDetails),
    interviewMatched: interviewNotes.length,
    questionsNew: newQuestions.length,
    questionsSelected: selectedQuestions.length,
    bankDocUrl,
    newQuestions,
    failures: [...search.failures, ...detail.failures],
    interviewFailures: interviewSearch.failures.concat(interviewDetail.failures),
    notes,
    message,
  };
}

export async function withAutomationTab(fn) {
  const tab = await createAutomationTab();
  const cdp = new CdpClient(tab.webSocketDebuggerUrl);
  try {
    await cdp.open();
    return await fn(cdp);
  } finally {
    cdp.close();
    await closeAutomationTab(tab.id);
  }
}

export async function runJobsXhsPushInBrowser(cfg, options = {}) {
  return withAutomationTab((cdp) => runJobsXhsPush(cfg, { ...options, cdp }));
}

export function formatRunSummary(result) {
  if (!result.message) return '没有符合条件的新岗位或新面经。';
  if (result.dryRun) return result.message;
  return result.sent
    ? `已推送 ${result.selected} 条岗位、${result.questionsSelected} 条面经考点` +
      (result.hidden ? `，另有 ${result.hidden} 条岗位顺延` : '') +
      '。'
    : '没有需要推送的新内容。';
}
