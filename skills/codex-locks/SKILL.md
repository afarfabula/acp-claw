---
name: codex-locks
description: 排查「codex resume 报 already has an active writer」——列出谁占着会话写锁，并按需结束那些不在用户当前终端里的占用进程
trigger: 当用户说 resume/恢复会话失败、会话被占用、想把不在自己终端里的 codex 会话停掉/清掉，或询问哪些 codex 进程占着锁时
---

# Codex 会话写锁（codex-locks）

## Purpose

`codex resume <id>` 报 `thread ... already has an active writer (code -32600)` 时，说明这个会话的
**写锁**被别的进程占着：Codex 在 `~/.codex/thread-writer-locks/<threadId>.lock` 上持 flock，
只要持有者没退出，谁也 resume 不了。本工具负责找出持有者并按需结束它。

## 代码来源

- 源码在仓库 `acp-claw` 的 `tools/codex-locks/`（`cli.mjs` / `locks.mjs` / `render.mjs`），
  工作区入口是软链接 `~/.acp-claw/tools/codex-locks`
- 自测：`node ~/.acp-claw/tools/codex-locks/test-locks.mjs`（**要在沙箱外跑**）

## 必须提权执行

沙箱内 `/proc` 是隔离的，只能看到沙箱自己的几个进程 —— **不提权跑出来的一定是错的**
（会显示「没有被占用」）。所以本工具属于「需要提权执行」的那类命令。

## 常用命令

```bash
CLI=~/.acp-claw/tools/codex-locks/cli.mjs

node $CLI list                     # 谁占着哪个会话（默认只列被占用的）
node $CLI list --all               # 连残留锁文件一起列
node $CLI free <threadId|前缀>      # 预览：释放指定会话
node $CLI free <threadId> --yes    # 真的结束持有它的进程
node $CLI clean                    # 预览：清理不在当前终端的占用者
node $CLI clean --yes              # 真的执行
node $CLI clean --yes --idle 60    # 只清「60 分钟没活动」的
```

## 处理用户的「会话被占用」时怎么做

1. 先 `list`，把结果（会话标题 + 终端 + 已占多久 + 来源）**照原样贴给用户**，让用户确认要清哪个
2. 用户只想恢复某一个会话 → `free <那个 id> --yes`，然后告诉用户「现在可以 resume 了」
3. 用户说「把不在我终端里的都清了」→ 先跑 `clean`（预览）给用户看，确认后再 `clean --yes`
4. 清完用 `list` 复查，回复里说明哪个锁释放了、还剩哪些

## 安全默认（不要绕过）

- `clean` / `free` **不加 `--yes` 只预览**，默认永远不会杀进程 —— 先把预览给用户看
- **默认不碰后台 app-server**（无 tty 的进程）：那是 acp-claw 机器人的会话，要动得显式加
  `--include-servers`，并且**必须先得到用户明确同意**
- 机器人代跑时没有 tty，工具会自动保留「最近打开的那个交互式会话」（很可能就是用户正在用的
  那个终端），回复里要把这条说明白；用户确认不需要保留时才加 `--no-keep-newest`
- 只结束同一个用户的 `codex` / `codex-acp` / `node` 类进程，只发 SIGTERM

## 回答用户时的要点

- 根因一句话说清：**锁文件残留不算占用，有进程开着它才算**；那个进程通常是用户在
  code-server / Trae / VS Code Web 终端里开过、浏览器关了但服务端没死的 `codex`
- **Ctrl+Z / 暂停不解决问题**：fd 没关，锁还占着，必须让进程退出
- 结束进程不丢会话：rollout 记录还在，锁一释放就能 resume
- 想根治：codex 里用 `/quit` 退出；或者把 code-server 的
  `terminal.integrated.enablePersistentSessions` 关掉（关了浏览器就杀终端）
- 不要建议用户 `kill -9` 一堆进程；用本工具，先看预览
