# ACP Claw

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/typescript-5.x-blue.svg)
![ACP](https://img.shields.io/badge/protocol-ACP-purple.svg)

**永不下线的 AI 编程助手 —— 通过飞书消息驱动任意 AI Agent 写代码。**

[English](./README.md) | 简体中文

---

## 为什么需要 ACP Claw？

传统的 AI 编程助手有个共同的痛点：你得开着终端、手动启动会话，一旦关掉窗口就丢失了所有上下文。

**如果你的 AI 编程助手能像后台服务一样，7×24 小时待命，随时从聊天窗口接收指令呢？**

ACP Claw 就是为此而生的。它作为一个常驻守护进程运行：

- 实时监听飞书/Lark 消息，随时响应你的编程需求
- 通过 ACP 协议连接任意 AI Agent（Codex、Claude Code、Gemini 等）
- 跨会话保持记忆和上下文，重启也不丢失
- 直接帮你写代码、执行命令、读写文件 —— 你只管在聊天里说需求

不用再切换窗口，不用再管终端状态。发条消息，剩下的交给 Agent。

---

## 核心特性

- **长生命周期守护进程** — 后台常驻，永不休眠，随时待命
- **ACP 万能适配器** — 兼容任何实现了 [Agent Client Protocol](https://github.com/anthropics/agent-client-protocol) 的 AI Agent
- **多通道接入** — 飞书 + A2A 协议；可插拔的 Channel 架构
- **Session 自动恢复** — 通过 `resume > load > create` 三级回退策略自动重连 session
- **多 Session 管理** — 支持每个用户同时运行多个 session，可创建、切换、列出、删除
- **定时任务 (Cron)** — 通过 cron 表达式设置定时任务，自动触发 Agent 执行
- **会话持久化** — 即使重启服务，也能无缝衔接之前的对话
- **记忆系统** — Agent 会记住你的项目背景、技术决策和偏好
- **Reflexion Pipeline** — 自动反思 Agent 输出，提升回答质量
- **斜杠命令** — 通过 `/` 命令快速控制 Agent 行为
- **多 Agent 切换** — 在不同的 AI Agent 之间自由切换

---

## 支持的 Agent

| Agent | 启动命令 | 说明 |
|-------|----------|------|
| Codex | `npx @zed-industries/codex-acp` | Zed 出品的 Codex Agent |
| Claude Code | `npx @agentclientprotocol/claude-agent-acp` | Anthropic 的 Claude Code Agent |
| Gemini | `gemini --acp` | Google 的 Gemini Agent |
| 自定义 | 任何支持 `--acp` 参数的可执行文件 | 接入你自己的 ACP Agent |

---

## 快速开始

### 1. 安装

```bash
npm install -g acp-claw
```

### 2. 初始化项目

```bash
acp-claw init
```

这会在你的项目目录下创建 `.acp-claw/` 配置目录，包含默认配置文件。

### 3. 配置

编辑 `.acp-claw/config.yaml`，填入飞书应用凭证并选择 Agent：

```yaml
feishu:
  app_id: "your-app-id"
  app_secret: "your-app-secret"

agent:
  command: "npx @agentclientprotocol/claude-agent-acp"
  working_dir: "/path/to/your/project"

session:
  persistence: true
  memory: true
```

### 4. 启动

```bash
acp-claw run
```

守护进程已启动！现在去飞书给你的 Bot 发条消息试试吧。

### 更新

```bash
acp-claw update
```

---

## 架构

```mermaid
graph LR
    A[飞书/Lark] -->|WebSocket| C[Controller]
    B[A2A 客户端] -->|HTTP/SSE| C
    S[定时调度] -->|Cron| C
    C --> D[MessageDispatcher]
    D --> E[SessionManager]
    E --> F[AcpClient]
    F --> G[Codex]
    F --> H[Claude Code]
    F --> I[Gemini]
    F --> J[自定义 Agent]

    style A fill:#4e8cff,color:#fff
    style B fill:#ff7a45,color:#fff
    style S fill:#ffc53d,color:#fff
    style C fill:#36cfc9,color:#fff
    style D fill:#73d13d,color:#fff
    style E fill:#ffc53d,color:#fff
    style F fill:#9254de,color:#fff
```

**数据流向：**

```
Channel (飞书/A2A/定时调度) → Controller → Dispatcher → SessionManager → AcpClient → Agent
         ↑                                                                              ↓
         └──────────────────────────── Response ←───────────────────────────────────────┘
```

---

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令列表 |
| `/status` | 查看守护进程和 Agent 状态 |
| `/agent <name>` | 切换到指定 Agent |
| `/session new` | 创建新 session |
| `/session list` | 查看当前用户所有 session |
| `/session switch <id>` | 切换到指定 session |
| `/session delete <id>` | 删除 session |
| `/restart` | 重启 ACP client 连接 |
| `/memory` | 查看当前会话记忆 |
| `/clear` | 清空当前会话上下文 |
| `/language <en\|zh>` | 切换响应语言 |

---

## 定时任务 (Cron)

ACP Claw 支持基于 cron 表达式的定时任务，到达指定时间时自动触发 Agent 执行。

### CLI 命令

```bash
# 添加定时任务
acp-claw cron add --name "daily-standup" --schedule "0 9 * * 1-5" --prompt "生成今日站会摘要"

# 列出所有任务
acp-claw cron list

# 启用/禁用任务
acp-claw cron toggle --name "daily-standup" --enabled false

# 删除任务
acp-claw cron delete --name "daily-standup"
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--name` | 任务名称（唯一标识符） |
| `--schedule` | Cron 表达式（5 字段格式） |
| `--prompt` | 触发时发送给 Agent 的提示词 |
| `--chat-id` | （可选）指定回复消息的聊天 ID |
| `--one-shot` | （可选）执行一次后自动删除 |

### Cron 表达式示例

| 表达式 | 含义 |
|--------|------|
| `*/5 * * * *` | 每 5 分钟 |
| `0 9 * * *` | 每天 9:00 |
| `0 9 * * 1-5` | 工作日 9:00 |
| `30 18 * * 5` | 每周五 18:30 |
| `0 0 1 * *` | 每月 1 号 0:00 |

任务数据持久化在 `.acp-claw/scheduler/tasks.json`，重启不丢失。文件修改后自动热重载。

---

## 配置说明

ACP Claw 使用 YAML 格式的配置文件，位于 `.acp-claw/config.yaml`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `feishu.app_id` | string | 飞书应用 App ID |
| `feishu.app_secret` | string | 飞书应用 App Secret |
| `agent.command` | string | ACP Agent 的启动命令 |
| `agent.working_dir` | string | Agent 的工作目录 |
| `session.persistence` | boolean | 是否启用会话持久化 |
| `session.memory` | boolean | 是否启用记忆系统 |
| `session.max_history` | number | 会话中保留的最大消息数 |

---

## 本地开发

```bash
# 克隆仓库
git clone https://github.com/IanYu-Tree/acp-claw.git
cd acp-claw

# 安装依赖
npm install

# 构建
npm run build

# 开发模式运行
npm run dev

# 运行测试
npm test
```

---

## 共建邀请

欢迎社区一起贡献更多 Channel 和功能！

### Channel 支持情况

| Channel | 状态 | 说明 |
|---------|------|------|
| 飞书/Lark | ✅ 已完成 | 基于 WebSocket 的消息通道 |
| A2A 协议 | ✅ 已完成 | Agent-to-Agent HTTP/SSE 通信 |
| Slack | 🙏 期待共建 | Slack Bot Events API |
| Discord | 🙏 期待共建 | Discord Bot 集成 |
| Telegram | 🙏 期待共建 | Telegram Bot API |
| WhatsApp | 🙏 期待共建 | WhatsApp Business API |
| 钉钉 | 🙏 期待共建 | 钉钉机器人 webhook/stream |
| 企业微信 | 🙏 期待共建 | 企业微信机器人 |

### 同会话消息注入（session-inject）

支持通过本地 HTTP 接口把外部条件触发的消息注入到指定会话中，LLM 会带着该会话的
完整上下文推理并把回复发回对应聊天，效果等同于「用户在这里发了一条消息」。
适用于监控告警、条件提醒等需要主动发消息的场景。详见 [tools/README.md](./tools/README.md)。

### 飞书云文档工具（feishu-doc）

让 agent 以用户身份或应用身份读写飞书云文档与知识库：读取 / 创建 / 追加 Markdown /
定点修改块 / 导出表格 / 搜索知识库 / 批量重组目录。配套 skill 放在
[`skills/feishu-doc/SKILL.md`](./skills/feishu-doc/SKILL.md)，
用法与权限说明见 [`tools/feishu-doc/README.md`](./tools/feishu-doc/README.md)。
非官方补充工具（GPU 监控）见 [`tools/gpu-monitor`](./tools/gpu-monitor)。

### 如何贡献新 Channel

1. 在 `src/channel/` 下新建文件（如 `src/channel/slack.ts`）
2. 实现 `src/types/channel.ts` 中的 `Channel` 接口
3. 在 `src/app/controller.ts` 中注册
4. 提交 PR！

欢迎任何形式的贡献 — 新 Channel、Bug 修复、文档改进或建议。欢迎先开 Issue 讨论。

---

## 开源协议

[MIT](./LICENSE) © IanYu
