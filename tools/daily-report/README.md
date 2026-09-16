# daily-report —— 每日定时简报

给「每天固定时间让大模型写一份日报」这类需求做的采集+投递工具，配合 acp-claw 的 cron 任务使用：

```text
cron（每天 08:30，--fresh-session）→ 新会话里的 agent
        │  1) 运行 cli.mjs collect   采集素材（天气/余额/论文/Infra/项目 commit）
        │  2) 模型据此写日报正文
        │  3) 运行 cli.mjs publish   写入飞书文档（按月自动建文档）
        ▼
      最终回复被 cron 的 --chat-id 直接发到飞书群
```

## 采集内容

| 板块 | 数据源 | 说明 |
| --- | --- | --- |
| 天气 | Open-Meteo（无需 key） | 指定经纬度的未来 N 小时逐小时预报（默认电子科技大学清水河校区） |
| API 余额 | `GET https://api.deepseek.com/user/balance` | key 取 `DEEPSEEK_API_KEY` 环境变量，回退到 `~/.bashrc` |
| 学术论文 | arXiv API + HF Daily Papers（含 `hf-mirror.com` 镜像） | 按主题查询最近 N 小时提交 + 当日热榜 |
| Infra 动态 | GitHub API | 关注仓库的新 release、近期高星新项目、账号下的 push 事件 |
| 项目进展 | 本地 `git log/status` + GitHub 事件 | “用最新 commit 当记忆”，含未提交改动数量 |

## 用法

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs

node $CLI collect                     # 采集素材：打印 Markdown，落盘 data/<日期>.json 与 <日期>-brief.md
node $CLI collect --json              # 只打印落盘路径
node $CLI publish --file <日报.md>     # 写入飞书文档（按 config.feishu.docTitlePattern 自动建/找当月文档）
node $CLI publish --file <日报.md> --chat oc_xxx   # 同时用应用身份发一份到群
node $CLI config                      # 查看运行时配置
```

## 配置

运行时配置放在仓库之外：`~/.acp-claw/daily-report/config.json`（可用 `DAILY_REPORT_HOME` / `DAILY_REPORT_CONFIG` 覆盖）。
不存在时会退回仓库内的 [config.example.json](./config.example.json)。常用字段：

- `weather.latitude/longitude/name/hours`：地点与预报时长
- `papers.arxiv[]`：主题 + arXiv 查询串；`papers.hfDailyPapers`：HF 热榜（`base` 可指向镜像）
- `infra.releases[]`：关注的 GitHub 仓库；`infra.trending`：近期高星新项目
- `projects.local[]`：本地仓库（`name` + `path`）；`projects.github.user`：账号级 push 事件
- `feishu.docTitlePattern`：日报文档标题模板，支持 `{yyyy}` `{MM}` `{date}` `{month}`
- `feishu.chatId`：默认群（`publish --chat` 未指定时不会自动使用，交给 cron 任务的 `--chat-id`）

## 投递说明

- 写文档走 `tools/feishu-doc`（用户身份，令牌在 `~/.acp-claw/feishu-doc-data/user-token.json`），因此在飞书里看到的是「你写的」文档
- 发群消息走应用身份（`im/v1/messages`），要求机器人已在该群里
- 日报正文默认由 cron 任务的最终回复发到群里，`publish --chat` 只是备用通道

## 与 cron 配合

```bash
acp-claw cron add \
  --name 每日简报 \
  --schedule "30 8 * * *" \
  --chat-id oc_xxxxxxxx \
  --fresh-session \
  --prompt "运行 tools/daily-report/cli.mjs collect；据此写 400 字以内的中文日报…"
```

`--fresh-session`：每次触发都新建会话，本轮结束后关闭——上下文不累积（省 token）、也不会每天多留一个常驻 agent 进程。
不传该参数时，定时任务会复用 `scheduler_<任务名>_1` 会话，上下文逐日累积。

## 注意事项

- 沙箱内无网络：手工调用请提权执行
- GitHub API 未鉴权时限 60 次/小时；如频繁调用可设置 `GITHUB_TOKEN`
- 用户令牌 refresh 有效期 30 天，长期不用需重新授权（见 feishu-doc skill）
