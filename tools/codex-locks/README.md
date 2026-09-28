# codex-locks —— 查看 / 清理占着会话锁的 Codex 进程

`codex resume <id>` 报下面这个错时用本工具：

```text
thread <id> already has an active writer (code -32600)
```

## 为什么会这样

Codex 保证**同一个会话只有一个写者**：它在 `~/.codex/thread-writer-locks/<threadId>.lock`
上持一把文件锁（flock），谁先拿到谁就是写者，直到进程退出、关闭 fd 为止。

两个容易踩的点：

1. **锁文件残留 ≠ 被占用**。文件一直留在那儿，只有「有进程开着它」才算被占；本工具看的
   正是后者（扫 `/proc/<pid>/fd` 的 dev:ino）。
2. **Ctrl+Z / SIGSTOP 不算退出**。进程被挂起时 fd 还开着，锁照样占着，`resume` 依旧失败，
   必须让进程真正退出（`SIGTERM`）。

最常见的元凶：在 **code-server / Trae / VS Code 的 Web 终端**里开过 `codex`，浏览器标签页关了
但服务端 terminal 还活着，那个 TUI 就一直占着会话（能占好几天）。

## 命令

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/codex-locks/cli.mjs

node $CLI list                 # 列出被占用的会话锁（谁、在哪个终端、占了多久）
node $CLI list --all           # 连「没人持有」的残留锁文件一起列
node $CLI list --json          # 给程序看
node $CLI free 01a0c8c7        # 预览：释放某个会话（支持 id 前缀）
node $CLI free 01a0c8c7 --yes  # 真的结束持有它的进程
node $CLI clean                # 预览：清理「不在当前终端」的占用者
node $CLI clean --yes          # 真的执行
```

输出示例：

```text
● 01a0c8c7-9d65  检查quyanyi是否占用4ka…   PID 3799237 · tty pts/60 · code-server · 已占 5d20h · 最后活动 5d20h前
● 01a0e6e9-f45a  我在resume的时候为啥一…   PID 3891652 · 无终端 · app-server · 已占 11m · 最后活动 2s前
```

## 选项

| 选项 | 说明 |
| --- | --- |
| `--codex-home <dir>` | Codex 目录（默认 `$CODEX_HOME` 或 `~/.codex`） |
| `--keep <tty\|pid>` | 额外保留（可重复：`--keep pts/15 --keep 12345`） |
| `--include-servers` | 连后台 app-server 一起清（默认跳过，见下） |
| `--idle <分钟>` | 只清「最后活动超过 N 分钟」的会话 |
| `--no-keep-newest` | 不保留「最近打开的那个终端」（默认保留） |
| `--force` | 不检查进程名（默认只结束 codex / node 类进程） |
| `--yes` | 真正执行；不加只预览 |
| `--json` | 输出 JSON |

## 安全默认

清理是不可逆的操作（会结束进程），所以默认做了这几件事：

- **默认只预览**，`--yes` 才真正动手；
- **从不碰后台 app-server**（无 tty 的那些）——那是 acp-claw 机器人的会话，要动得显式加
  `--include-servers`；
- **不碰当前终端**（`clean` 会读 `/proc/self/fd/*` 认出自己所在的 tty）；
- **调用方不在 tty 里时**（机器人 / 脚本代跑）额外保留「最近打开的那个交互式会话」，
  它很可能就是用户正在用的终端；确实要清就加 `--no-keep-newest`；
- 只结束**同一个用户**、且进程名是 `codex` / `codex-acp` / `node` 类的进程；
- 只发 `SIGTERM`，之后复查锁是否真的释放；进程赖着不走会提示手动 `kill -9`。

## 自测

```bash
node tools/codex-locks/test-locks.mjs
```

全部在临时 `CODEX_HOME` 里做（自己 fork 进程模拟「占锁的会话」），不会碰真实 `~/.codex`，
也不会误杀你的会话。**要在沙箱外跑**：沙箱内 node 子进程的管道输出会被丢弃，测试会直接提示。

## 注意

- 沙箱内 `/proc` 是隔离的，看不到宿主进程——**在沙箱里跑本工具只会看到沙箱自己**，
  所以要提权/在沙箱外运行（acp-claw 里就是「需要提权执行」的那类命令）。
- 结束进程不会删会话，rollout 记录还在，锁一释放就能正常 `codex resume`；
  锁文件本身会一直留着（空文件），不影响任何事。
- 想根治「关了浏览器还占着会话」：codex 里用 `/quit` 退出，或给 code-server 关掉
  `terminal.integrated.enablePersistentSessions`。
