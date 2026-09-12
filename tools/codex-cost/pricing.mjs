/**
 * Codex 会话花费的价格表与峰谷规则（人民币）。
 *
 * 价格来源：DeepSeek 官方中文价格页
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 峰谷规则：北京时间周一至周五 09:00-12:00、14:00-18:00 为高峰，
 *   其余时段与周末全天为空闲，空闲价为高峰价的一半。
 *
 * 单价单位：元 / 百万 token。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const TOKENS_PER_UNIT = 1_000_000;

export const CURRENCY = 'CNY';
export const CURRENCY_SYMBOL = '¥';

export const DEFAULT_MODEL = 'deepseek-flash';

export const PRICING = {
  'deepseek-flash': {
    label: 'DeepSeek-V4.1-Flash',
    peak: { input: 2, output: 8, cacheRead: 0.04 },
    offPeak: { input: 1, output: 4, cacheRead: 0.02 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-V4-Pro',
    peak: { input: 9, output: 27, cacheRead: 0.3 },
    offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15 },
  },
};

/** 已退役 / 别名模型名 → 现行计价模型 */
const MODEL_ALIASES = new Map(
  Object.entries({
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash',
  }),
);

export function resolveModel(model) {
  const key = String(model ?? '')
    .trim()
    .toLowerCase();
  if (!key) return DEFAULT_MODEL;
  if (PRICING[key]) return key;
  if (MODEL_ALIASES.has(key)) return MODEL_ALIASES.get(key);
  const prefix = Object.keys(PRICING).find((name) => key.startsWith(name));
  return prefix ?? DEFAULT_MODEL;
}

/** 北京时间高峰时段判定（周一至周五 09-12、14-18） */
export function isPeak(date = new Date()) {
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const weekday = beijing.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 取某时刻某模型的单价档 */
export function rateFor(model, date = new Date()) {
  const key = resolveModel(model);
  const table = PRICING[key];
  const peak = isPeak(date);
  return {
    key,
    label: table.label,
    peak,
    peakLabel: peak ? '高峰' : '空闲',
    rate: peak ? table.peak : table.offPeak,
  };
}

/**
 * 单轮花费（元）。
 * usage: { input_tokens, cached_input_tokens, output_tokens }
 * 注意：cached_input_tokens 是 input_tokens 的子集（DeepSeek 的 prompt cache 命中量）。
 */
export function costOfTurn(usage, model, date = new Date()) {
  const { key, peak, rate } = rateFor(model, date);
  const input = Number(usage?.input_tokens ?? 0);
  const cached = Number(usage?.cached_input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const miss = Math.max(input - cached, 0);

  const missCost = (miss / TOKENS_PER_UNIT) * rate.input;
  const cacheCost = (cached / TOKENS_PER_UNIT) * rate.cacheRead;
  const outputCost = (output / TOKENS_PER_UNIT) * rate.output;

  return {
    model: key,
    peak,
    miss,
    cached,
    output,
    cost: missCost + cacheCost + outputCost,
    input: missCost + cacheCost,
    outputCost,
  };
}

/** 元，自适应小数位 */
export function formatCny(value) {
  const v = Number(value ?? 0);
  const abs = Math.abs(v);
  if (abs >= 100) return `¥${v.toFixed(1)}`;
  if (abs >= 1) return `¥${v.toFixed(2)}`;
  if (abs >= 0.01) return `¥${v.toFixed(3)}`;
  return `¥${v.toFixed(4)}`;
}

/** 1.2M / 57k / 996k */
export function formatTokens(value) {
  const n = Number(value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}
