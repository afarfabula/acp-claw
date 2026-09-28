# sem —— Codex 会话管理器（Session Manager）

`codex resume <id>` 报下面这个错时用它：

```text
thread <id> already has an active writer (code -32600)
```

`sem` 会把「谁占着哪个会话」列清楚（会话标题、PID、终端、来源、占了多久），
并帮你把已经不在你终端里的那些占用者放掉。

## 快速开始

```bash
sem                        # 交互式界面（默认）
sem list                   # 打印列表（脚本/管道友好）
sem free 01a0c8c7          # 预览：释放这个会话
sem free 01a0c8c7 --yes    # 真的结束持有它的进程
sem clean                  # 预览：清理「不在当前终端」的占用者
sem clean --yes            # 真的执行
sem help                   # 完整用法
```

安装（让 `sem` 直接可用）：

```bash
ln -sfn /home_ext/quyanyi/acp-claw/tools/sem/cli.mjs ~/.local/bin/sem
chmod +x /home_ext/quyanyi/acp-claw/tools/sem/cli.mjs
```

## 交互式界面

```text
╭─ sem · Codex Session Manager ──────────────────────── 12 项 · 12 占用 ─╮
│ ● 01a0c8c7-9d65  检查quyanyi是否占用4ka跑实验   3799237 pts/60 code-server 5d20h │
│ ● 01a0e6e9-f45a  我在resume的时候为啥一直会遇到… 3891652 —      app-server  27m │
│                                                                         │
│ 01a0c8c7-9d65-71b2-9303-3b827e1b3ebc                                    │
│ ● · PID 3799237 · codex · tty pts/60 · code-server · 已占 5d20h          │
│ cwd /home_ext/quyanyi · cmd codex                                       │
╰─ ↑↓/jk 选择 · Enter/f 释放 · c 清理 · a 全部 · r 刷新 · q 退出 ─────────╯
```

| 按键 | 作用 |
| --- | --- |
| `↑` `↓` / `j` `k` | 选择会话（`g` / `G` 跳到首尾） |
| `Enter` / `f` | 释放选中的会话（会先确认 `[y/N]`） |
| `c` | 一键清理「不在当前终端」的占用者（会先确认） |
| `a` | 在「只看被占用」和「显示全部锁文件」之间切换 |
| `r` | 立即刷新（默认每 1.5s 自动刷新） |
| `q` / `Ctrl-C` | 退出 |

颜色：红色＝可直接清理、绿色＝你自己所在的终端、蓝色＝后台 app-server（机器人会话）、
灰色＝空闲锁文件 / 其他用户。宽度 ≥ 90 列时显示 PID / tty / 来源 / 最后活动，窄终端自动精简。

## 子命令与选项

| 命令 | 说明 |
| --- | --- |
| `sem` / `sem tui` | 交互式界面（非 TTY 时自动降级成 `sem list`） |
| `sem list` / `sem ls` | 列出锁与持有者；`--all` 连空闲锁文件一起列，`--json` 输出 JSON |
| `sem free <id\|前缀>` | 释放指定会话；不带 `--yes` 只预览 |
| `sem clean` | 清理不在当前终端的占用者；不带 `--yes` 只预览 |
| `sem version` / `sem help` | 版本 / 帮助 |

| 选项 | 说明 |
| --- | --- |
| `--codex-home <dir>` | Codex 目录（默认 `$CODEX_HOME` 或 `~/.codex`） |
| `--keep <tty\|pid>` | 额外保留（可重复：`--keep pts/15 --keep 12345`） |
| `--include-servers` | 连后台 app-server 一起清（默认跳过） |
| `--idle <分钟>` | 只清「最后活动超过 N 分钟」的会话 |
| `--no-keep-newest` | 不在当前终端时也保留「最近打开的会话」（默认保留） |
| `--force` | 不检查进程名（默认只结束 codex / node 类进程） |
| `--yes` | 真正执行；不加只预览 |
| `--json` / `--no-color` | JSON 输出 / 关闭颜色 |

## 原理

Codex 保证**同一个会话只有一个写者**：它在 `~/.codex/thread-writer-locks/<threadId>.lock`
上持一把文件锁（flock），直到进程退出、fd 关闭为止。两个容易踩的点：

1. **锁文件残留 ≠ 被占用**。文件一直留在那儿，只有「有进程开着它」才算被占；`sem` 扫的是
   `/proc/<pid>/fd` 的 dev:ino。
2. **Ctrl+Z / SIGSTOP 不算退出**。进程被挂起时 fd 还开着，锁照样占着，`resume` 依旧失败，
   必须让进程真正退出（`SIGTERM`）。

最常见的元凶：在 **code-server / Trae / VS Code 的 Web 终端**里开过 `codex`，浏览器标签页关了
但服务端 terminal 还活着，那个 TUI 就一直占着会话（能占好几天）。

## 安全默认

清理会结束进程，所以默认做了这些保护：

- **默认只预览**，`--yes` 才动手（交互界面里也要按 `y` 确认）；
- **从不碰后台 app-server**（无 tty 的那些）——那是 acp-claw 机器人的会话，要动得显式加
  `--include-servers`；
- **不碰你当前所在的终端**（读 `/proc/self/fd/*` 认自己的 tty）；
- **调用方不在 tty 里时**（机器人 / 脚本代跑）额外保留「最近打开的那个交互式会话」，
  它很可能就是你正在用的终端；确实要清就加 `--no-keep-newest`；
- 只结束**同一个用户**、且进程名是 `codex` / `codex-acp` / `node` 类的进程；
- 只发 `SIGTERM`，之后复查锁是否真的释放；进程赖着不走会提示手动 `kill -9`。

## 自测

```bash
node tools/sem/test-sem.mjs
```

43 项检查：纯函数、TUI 行渲染宽度、清理目标选择、以及端到端（临时 `CODEX_HOME` + 自己 fork
的占锁进程）。不会碰真实 `~/.codex`，也不会误杀你的会话。
**要在沙箱外跑**：沙箱内 node 子进程的管道输出会被丢弃，测试会直接提示。

## 注意

- 沙箱内 `/proc` 是隔离的，看不到宿主进程——在沙箱里跑 `sem` 只会看到沙箱自己，
  所以要提权/在沙箱外运行（acp-claw 里就是「需要提权执行」的那类命令）。
- 结束进程不会删会话，rollout 记录还在，锁一释放就能正常 `codex resume`；
  锁文件本身会一直留着（空文件），不影响任何事。
- 想根治「关了浏览器还占着会话」：codex 里用 `/quit` 退出，或给 code-server 关掉
  `terminal.integrated.enablePersistentSessions`。
