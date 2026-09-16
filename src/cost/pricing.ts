/**
 * DeepSeek 官方人民币价目表与峰谷规则（元 / 百万 token）。
 *
 * 与工作区工具 `tools/codex-cost/pricing.mjs` 同一口径：
 *   flash 高峰 ¥2 / ¥8 / ¥0.04（未命中输入 / 输出 / 缓存命中），空闲半价
 *   高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00，其余与周末半价
 *
 * 改价时两处都要改（这里是 acp-claw 运行时用的副本，避免运行时依赖工作区路径）。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const TOKENS_PER_UNIT = 1_000_000;

export interface Rate {
  input: number;
  output: number;
  cacheRead: number;
}

interface ModelPricing {
  label: string;
  peak: Rate;
  offPeak: Rate;
}

export const DEFAULT_MODEL = 'deepseek-flash';

export const PRICING: Record<string, ModelPricing> = {
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
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
};

export function resolveModel(model?: string | null): string {
  const key = String(model ?? '')
    .trim()
    .toLowerCase();
  if (!key) return DEFAULT_MODEL;
  if (PRICING[key]) return key;
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
  const prefix = Object.keys(PRICING).find((name) => key.startsWith(name));
  return prefix ?? DEFAULT_MODEL;
}

/** 北京时间高峰时段判定（周一至周五 09-12、14-18） */
export function isPeak(date: Date = new Date()): boolean {
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const weekday = beijing.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export interface TokenUsage {
  input?: number;
  cached?: number;
  output?: number;
}

export interface TurnCost {
  model: string;
  peak: boolean;
  cost: number;
}

/**
 * 单次请求的花费（元）。
 * cached 是 input 的子集（DeepSeek 前缀缓存命中量），未命中 = input - cached。
 */
export function costOfTurn(
  usage: TokenUsage,
  model?: string | null,
  date: Date = new Date(),
): TurnCost {
  const key = resolveModel(model);
  const peak = isPeak(date);
  const rate = peak ? PRICING[key].peak : PRICING[key].offPeak;
  const input = Number(usage.input ?? 0);
  const cached = Math.min(Number(usage.cached ?? 0), input);
  const output = Number(usage.output ?? 0);
  const miss = Math.max(input - cached, 0);

  const cost =
    (miss / TOKENS_PER_UNIT) * rate.input +
    (cached / TOKENS_PER_UNIT) * rate.cacheRead +
    (output / TOKENS_PER_UNIT) * rate.output;

  return { model: key, peak, cost };
}

/** 元，自适应小数位（与 codex-cost 状态栏同款） */
export function formatCny(value: number): string {
  const v = Number(value ?? 0);
  const abs = Math.abs(v);
  if (abs >= 100) return `¥${v.toFixed(1)}`;
  if (abs >= 1) return `¥${v.toFixed(2)}`;
  if (abs >= 0.01) return `¥${v.toFixed(3)}`;
  return `¥${v.toFixed(4)}`;
}
