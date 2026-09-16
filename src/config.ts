import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentConfig {
  command: string;
  args?: string[];
  /**
   * 额外环境变量，启动该 agent 进程时注入（会覆盖继承的环境变量）。
   * 典型用法：给定时任务用的 agent 单独指定 DEEPSEEK_API_KEY，实现独立计费。
   */
  env?: Record<string, string>;
}

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  appName?: string;
  chatId?: string;
  /** 群聊是否要求 @ 机器人（或包含 appName）才处理，默认 true；设为 false 则处理群里所有消息 */
  groupRequireMention?: boolean;
}

export interface A2AChannelConfig {
  port: number;
  name: string;
  description: string;
}

export interface InjectChannelConfig {
  /** 本地 HTTP 服务端口 */
  port: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 可选鉴权 token，请求时需带 Authorization: Bearer <token> */
  token?: string;
}

export interface AcpClawConfig {
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  feishu?: FeishuChannelConfig;
  a2a?: A2AChannelConfig;
  /** 同会话消息注入通道（本地 HTTP） */
  inject?: InjectChannelConfig;
  /** 会话隔离粒度：'user' = 同一用户跨聊天共享上下文（默认）；'chat' = 每个聊天独立会话 */
  sessionMode?: 'user' | 'chat';
  sessionIdleTimeoutMs?: number;
  stateSaveIntervalMs?: number;
  forwardToolMessages?: boolean;
  language?: 'zh' | 'en';
  reflexion?: {
    enabled: boolean;
    promptTemplate?: string;
    minContentLength?: number;
    layers?: {
      memory: boolean;
      skills: boolean;
      knowledge: boolean;
    };
  };
}

const FALLBACK_AGENTS: Record<string, AgentConfig> = {
  codex: { command: 'npx', args: ['@zed-industries/codex-acp@^0.12.0'] },
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@^0.31.0'],
  },
};

const DEFAULT_CONFIG: AcpClawConfig = {
  defaultAgent: '',
  agents: {},
  sessionIdleTimeoutMs: 30 * 60_000,
  stateSaveIntervalMs: 30_000,
  language: 'zh' as const,
};

export function resolveWorkDir(workDir?: string): string {
  return workDir || join(process.cwd(), '.acp-claw');
}

export function getConfigPath(workDir: string): string {
  return join(workDir, 'config.json');
}

export function loadConfig(workDir: string): AcpClawConfig {
  const configPath = getConfigPath(workDir);
  if (!existsSync(configPath)) {
    return {
      ...DEFAULT_CONFIG,
      defaultAgent: 'codex',
      agents: { ...FALLBACK_AGENTS },
    };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AcpClawConfig>;
    const userAgents = parsed.agents ?? {};
    // 如果用户没有配置任何 agent，使用内置 fallback
    const agents =
      Object.keys(userAgents).length > 0
        ? userAgents
        : { ...FALLBACK_AGENTS, ...userAgents };
    // defaultAgent 优先用户配置，其次取 agents 中第一个
    const defaultAgent =
      parsed.defaultAgent || Object.keys(agents)[0] || 'codex';
    return {
      defaultAgent,
      agents,
      feishu: parsed.feishu ?? loadFeishuConfigFromEnv(),
      a2a: parsed.a2a,
      inject: parsed.inject,
      sessionMode: parsed.sessionMode ?? 'user',
      sessionIdleTimeoutMs:
        parsed.sessionIdleTimeoutMs ?? DEFAULT_CONFIG.sessionIdleTimeoutMs,
      stateSaveIntervalMs:
        parsed.stateSaveIntervalMs ?? DEFAULT_CONFIG.stateSaveIntervalMs,
      language: parsed.language ?? 'zh',
      reflexion: parsed.reflexion,
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      defaultAgent: 'codex',
      agents: { ...FALLBACK_AGENTS },
    };
  }
}

export function saveConfig(workDir: string, config: AcpClawConfig): void {
  const configPath = getConfigPath(workDir);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const CRON_SKILL_CONTENT = `---
name: cron
description: 定时任务管理，支持 cron 表达式定时触发，通过 CLI 命令管理定时任务
trigger: 当用户需要设置定时提醒、定期执行任务、周期性操作时
---

# Cron 定时任务

## Purpose

使用 \`acp-claw cron\` CLI 命令管理定时任务。任务创建后会持久化存储并立即生效，到达指定时间时自动创建 session 执行。

## When to Use

- 用户要求定时提醒（如每天早上 9 点提醒站会）
- 用户需要周期性执行某个操作（如每小时检查服务状态）
- 用户要求定期发送消息到某个聊天群

## CLI Commands

### 添加定时任务

\`\`\`bash
acp-claw cron add --name <task-name> --schedule "<cron-expression>" --prompt "<prompt-text>" [--chat-id <chat-id>] [--one-shot]
\`\`\`

参数说明：
- \`--name\`: 任务名称（唯一标识符）
- \`--schedule\`: Cron 表达式（5 字段格式）
- \`--prompt\`: 触发时发送给 AI 的提示词
- \`--chat-id\`: （可选）指定回复消息的聊天 ID
- \`--one-shot\`: （可选）执行一次后自动删除

### 删除定时任务

\`\`\`bash
acp-claw cron delete --name <task-name>
\`\`\`

### 列出所有定时任务

\`\`\`bash
acp-claw cron list
\`\`\`

### 启用/禁用定时任务

\`\`\`bash
acp-claw cron toggle --name <task-name> --enabled true
acp-claw cron toggle --name <task-name> --enabled false
\`\`\`

## Cron Expression Format

5 字段格式: \`minute hour day month weekday\`

### Examples

- \`*/5 * * * *\` — 每 5 分钟
- \`0 * * * *\` — 每小时整点
- \`0 9 * * *\` — 每天 9:00
- \`0 9 * * 1-5\` — 工作日 9:00
- \`0 0 1 * *\` — 每月 1 号 0:00
- \`30 18 * * 5\` — 每周五 18:30
- \`0 9,18 * * *\` — 每天 9:00 和 18:00

## Behavior

- 任务创建后立刻生效，无需重启服务
- 触发时会创建独立的 cron session 执行 prompt
- oneShot 任务执行一次后自动删除
- 任务数据持久化在 \`scheduler/tasks.json\`
`;

export function initWorkDir(workDir: string): AcpClawConfig {
  const dirs = [
    workDir,
    join(workDir, 'memory'),
    join(workDir, 'knowledge'),
    join(workDir, 'sessions'),
    join(workDir, 'skills', 'cron'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // 生成包含自定义 agent 示例的配置模板
  const templateConfig: AcpClawConfig = {
    defaultAgent: 'codex',
    agents: {
      codex: { command: 'npx', args: ['@zed-industries/codex-acp@^0.12.0'] },
    },
    feishu: loadFeishuConfigFromEnv() ?? {
      appId: '<your-lark-app-id>',
      appSecret: '<your-lark-app-secret>',
      appName: '<your-bot-name>',
    },
    a2a: {
      port: 41007,
      name: 'acp-claw',
      description: 'ACP Claw A2A Agent',
    },
    inject: {
      port: 41008,
    },
    sessionIdleTimeoutMs: DEFAULT_CONFIG.sessionIdleTimeoutMs,
    stateSaveIntervalMs: DEFAULT_CONFIG.stateSaveIntervalMs,
    reflexion: { enabled: false },
  };

  // 如果已有配置文件，合并而非覆盖
  const existingConfig = loadConfig(workDir);
  const finalConfig: AcpClawConfig = existsSync(getConfigPath(workDir))
    ? existingConfig
    : templateConfig;

  saveConfig(workDir, finalConfig);

  // 初始化默认记忆文件
  const memoryFiles: Record<string, string> = {
    'IDENTITY.md': '# IDENTITY\n\n(描述你的 agent 身份和角色)\n',
    'USER.md': '# USER\n\n(描述用户信息和偏好)\n',
    'SOUL.md': '# SOUL\n\n(描述 agent 的性格和行为准则)\n',
    'AGENTS.md': '# AGENTS\n\n(描述可协作的其他 agent)\n',
    'TOOLS.md': '# TOOLS\n\n(描述可用的工具和能力)\n',
  };
  for (const [name, content] of Object.entries(memoryFiles)) {
    const filePath = join(workDir, 'memory', name);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
    }
  }

  // 初始化默认知识文件
  const knowledgePath = join(workDir, 'knowledge', 'core.md');
  if (!existsSync(knowledgePath)) {
    writeFileSync(
      knowledgePath,
      '# Core Knowledge\n\n(Add your knowledge here)\n',
    );
  }

  // Initialize built-in cron skill
  const cronSkillPath = join(workDir, 'skills', 'cron', 'SKILL.md');
  if (!existsSync(cronSkillPath)) {
    writeFileSync(cronSkillPath, CRON_SKILL_CONTENT);
  }

  return finalConfig;
}

export function isTemplateOnly(content: string): boolean {
  if (!content || content.trim() === '') return true;
  // Check if it only contains template headers and placeholder text in parentheses
  const stripped = content
    .replace(/^#.*$/gm, '')
    .replace(/\(.*?\)/g, '')
    .trim();
  return stripped === '';
}

export function readMemoryFile(
  workDir: string,
  filename: string,
): string | null {
  const filePath = join(workDir, 'memory', filename);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    return content;
  } catch {
    return null;
  }
}

export function loadFeishuConfigFromEnv(): FeishuChannelConfig | undefined {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) return undefined;
  return {
    appId,
    appSecret,
    domain: process.env.LARK_DOMAIN || 'https://open.feishu.cn',
    appName: process.env.LARK_APP_NAME,
    chatId: process.env.LARK_CHAT_ID,
  };
}
