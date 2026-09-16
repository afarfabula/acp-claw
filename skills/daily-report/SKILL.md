---
name: daily-report
description: 每日定时简报（天气/API 余额/论文与 Infra 动态/项目 commit 进展），采集、渲染并投递到飞书文档与群
trigger: 当用户需要每日/定期简报、天气+余额+论文+项目进展汇总、或调整日报内容与投递方式时
---

# 每日简报（daily-report）

## Purpose

把「每天固定时间给我一份日报」标准化成两步：**脚本采集事实** + **模型写结论**。
采集脚本负责所有联网取数（不易出错、可复现），模型只负责筛选、点评和成文（省 token）。

## 代码来源

- 源码维护在仓库 `acp-claw` 的 `tools/daily-report/`
- 运行时目录 `/home_ext/quyanyi/.acp-claw/tools/daily-report` 是指向仓库的软链接，改代码请改仓库文件
- 运行时配置与产物在仓库之外：`~/.acp-claw/daily-report/`（`config.json`、`state.json`、`data/`）

## 用到的能力

1. **cron 任务**（`acp-claw cron`）：定时触发，`--chat-id` 把最终回复发到群，`--fresh-session` 每次新建会话
2. **采集脚本**：`node <CLI> collect` —— 天气 / DeepSeek 余额 / arXiv+HF 论文 / Infra 动态 / 本地仓库 commit
3. **投递脚本**：`node <CLI> publish --file <md>` —— 追加到飞书文档（用户身份，按月自动建文档）
4. **feishu-doc skill**：需要手工读改文档时用

## Commands

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs

node $CLI collect                    # 采集素材 → 打印 Markdown（同时落盘 data/<日期>.json / -brief.md）
node $CLI collect --json             # 只输出落盘路径与失败项
node $CLI news                       # 采集 AI 新闻素材（RSS 多源 + HN Algolia）→ data/<日期>-news.md
node $CLI news --json                # 只输出落盘路径、条数与各源状态
node $CLI publish --file <md>        # 写入当月飞书文档
node $CLI publish --file <md> --chat <chatId>   # 同时发群（备用通道）
node $CLI publish --file <md> --title "AI新闻 {yyyy}-{MM}" --open-id <openId>  # 归档到新闻文档 + 推送单聊
node $CLI config                     # 查看运行时配置
```

沙箱内不能联网，调用本工具需要提权执行。

## 定时任务的固定套路

```bash
acp-claw cron add --name 每日简报 --schedule "0 7,12,18 * * *" \
  --chat-id <群 chat_id> \
  --daily-session --keep-session 86400000 --bind-chat \
  --agent codex-daily \
  --prompt "<见下方模板>"
```

参数含义：

- `--daily-session`：**当天多次触发复用同一个会话**，跨天自动新建（上下文不无限累积）
- `--keep-session 86400000`：触发后**保留会话 24 小时**再关闭，期间可以在群里继续追问
- `--bind-chat`：把该群绑定到这个会话，群里的后续消息会接着这个上下文（用 `/session new` 可解除绑定）
- `--agent codex-daily`：用配置里那个 agent（可挂独立 `DEEPSEEK_API_KEY`，实现**单独计费**）
- 时间点选在闲时（谷价）窗口：北京时间 07:00 / 12:00 / 18:00

prompt 模板（保持简短，细节交给 skill 与脚本）：

```text
生成今天的每日简报：按 skills/daily-report/SKILL.md 的「日报流程」执行
（先跑 collect 采集素材，再写日报，写入飞书文档；最终回复里必须带上飞书文档链接
和每篇推荐论文的链接）。
```

## 日报流程（模型侧步骤）

1. 运行 `node $CLI collect`，拿到素材 Markdown（含天气表、余额、论文列表、Infra 动态、项目 commit）
2. 写一份**中文**日报，控制在 500 字以内，结构固定：
   - ☀️ 天气：未来 24h 温度区间、降水概率峰值与时段、是否带伞、穿衣提示
   - 💰 DeepSeek 余额：当前余额 + 是否偏低（<¥20 提醒充值）
   - 📄 论文：按「Token 压缩 / 量化 / Infra」各挑 1–2 篇最有价值的，**每条都要带链接**
     （直接用素材里 `链接：` 那一行的 arXiv/HF 地址），并给一句话点评（为什么值得看）
   - 🛠 Infra 动态：框架新版本、值得关注的新项目（没有就明说「无」）
   - 📌 项目进展：按仓库列 24–48h 的新 commit 与未提交改动，指出「卡在哪 / 下一步」
3. 把日报正文写入临时文件（如 `/tmp/daily-report-YYYY-MM-DD.md`）
4. 运行 `node $CLI publish --file <那个文件>` 写入飞书文档（当月文档不存在会自动创建）
5. **最终回复 = 日报正文 + 链接块**（cron 任务会用 `--chat-id` 把它发到群），结尾固定加上：

   ```text
   📎 完整日报：<publish 输出里的 docUrl>
   📄 今日论文：
   - <论文标题> <arXiv 链接>
   - ...
   ```

   不要输出中间过程、不要复述工具原始输出。

## 常见问题

- 采集项失败不会中断：素材顶部会列出失败项，日报里说明「某项数据缺失」即可
- 文档写不进去（`permission denied`/令牌过期）：按 feishu-doc skill 重新授权
- 想调整主题、地点、项目清单：改 `~/.acp-claw/daily-report/config.json`，不用改代码
- 想让上下文累积（例如需要跨天对比）：去掉 cron 任务的 `--fresh-session`

## AI 新闻推送（个人单聊）

与日报同一套工具，只是换数据源与投递方式：**采集脚本取新闻事实，模型挑重点写成简报**。

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs

node $CLI news                                     # 素材（标题/链接/时间/摘要）
node $CLI publish --file /tmp/ai-news-<日期>.md \
  --title "AI新闻 {yyyy}-{MM}" \
  --open-id ou_1e23742cb643e73a7e99196db2b80b8e    # 应用身份推送单聊（用户 open_id）
```

- 新闻源在 `config.json` 的 `news` 块：`feeds[]`（任意 RSS/Atom，可给 `keywords` 过滤、`windowHours` 单独放宽）+ `hackerNews`（走 HN Algolia，按标题命中 + `minPoints` 过滤）
- 默认源：量子位、雷峰网、Google AI Blog、OpenAI News、HuggingFace Blog（`hf-mirror.com`）、Hacker News
- 推单聊用**应用身份**（`--open-id`），所以显示为机器人发的消息；正文同时按 `--title` 归档到飞书文档
- 定时任务「AI新闻」：`0 8 * * *`，`--fresh-session`（跑完即关，上下文不累积）；想改时间/频率改 cron，想改源改 `config.json`
