/**
 * 模型名 → 计费车道，规则与 `~/.codex/router/ark_router.py` 的 resolve_route 一致：
 *   带 `dsapi-` 前缀 → DeepSeek 官网 API（按 token 计人民币）
 *   其余模型名       → 火山方舟 Coding Plan（走套餐额度，不按 token 计费）
 *
 * 路由规则读 `~/.codex/router/config.json`（可用 ARK_ROUTER_CONFIG 覆盖），
 * 读不到时退回内置默认规则。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Lane = 'plan' | 'deepseek';

interface LaneRule {
  prefix: string;
  lane: Lane;
}

export interface LaneRules {
  defaultLane: Lane;
  prefixRoutes: LaneRule[];
}

const FALLBACK_RULES: LaneRules = {
  defaultLane: 'plan',
  prefixRoutes: [{ prefix: 'dsapi-', lane: 'deepseek' }],
};

export function routerConfigPath(): string {
  return (
    process.env.ARK_ROUTER_CONFIG ||
    join(homedir(), '.codex', 'router', 'config.json')
  );
}

export function laneRules(): LaneRules {
  try {
    const config = JSON.parse(readFileSync(routerConfigPath(), 'utf8')) as {
      default_lane?: unknown;
      prefix_routes?: Array<{ prefix?: unknown; lane?: unknown }>;
    };
    const routes = Array.isArray(config.prefix_routes)
      ? config.prefix_routes.map((rule) => ({
          prefix: String(rule?.prefix ?? ''),
          lane: String(rule?.lane ?? 'plan') as Lane,
        }))
      : FALLBACK_RULES.prefixRoutes;
    return {
      defaultLane: (config.default_lane as Lane) ?? FALLBACK_RULES.defaultLane,
      prefixRoutes: routes,
    };
  } catch {
    return FALLBACK_RULES;
  }
}

export function laneOfModel(
  model?: string | null,
  rules: LaneRules = laneRules(),
): Lane {
  const name = String(model ?? '');
  for (const rule of rules.prefixRoutes) {
    if (rule.prefix && name.startsWith(rule.prefix)) return rule.lane;
  }
  return rules.defaultLane;
}
