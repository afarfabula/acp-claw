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
node $CLI school                     # 采集学校/学院通知素材 → data/<日期>-school.md（放假/奖助/教学/学位，增量去重）
node $CLI school --json              # 只输出路径、新增条数与各源状态
node $CLI school --days 30           # 放宽时间窗（首次跑用，把存量一次性标为已读）
node $CLI school --all               # 忽略已读状态全部当作新增（调试用）
node $CLI comments                   # 列 Paper Reading 文档的批注，标出「还没处理过」的（增量，默认用 config 里的 docId）
node $CLI comments --doc <url>       # 指定别的文档；--rebuild 重建基线（把现有批注全当已读）
node $CLI reply <doc> <commentId> --text "回答"   # 在批注里回复（默认同时标记「已解决」，并记住进度）
node $CLI affil 2606.05688           # 查论文的完成单位（机构/团队）与作者
node $CLI paper 2606.05688           # 抓论文写文档素材（摘要/章节/图表图注+图片/完成单位）
node $CLI paperdoc --spec <json> --enrich <materials.json> [--check] [--publish --name <标题>]
                                     # 每周 Paper Reading 文档：格式校验 → 渲染 → 导入飞书
node $CLI publish --file <md>        # 写入当月飞书文档
node $CLI publish --file <md> --chat <chatId>   # 同时发群（备用通道）
node $CLI publish --file <md> --title "AI新闻 {yyyy}-{MM}" --open-id <openId>  # 归档到新闻文档 + 推送单聊
node $CLI doc-tree                   # 解析文档里的简报条目（日期/栏目/首行），只读
node $CLI fixdoc --dry               # 预览重排/规范化结果（先备份原稿）
node $CLI fixdoc                     # 重排 + 规范化当月文档（顺序错乱、格式不一时用）
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
（先跑 collect / news / school 三份素材，再写日报，写入飞书文档；最终回复里必须带上飞书文档链接
和每篇推荐论文的链接）。
```

## 日报流程（模型侧步骤）

1. 运行 `node $CLI collect`（天气/余额/论文/Infra/项目 commit）、`node $CLI news`（AI 新闻）、`node $CLI school`（学校/学院通知），拿到三份素材 Markdown
2. 合成一份**中文**简报，控制在 800 字以内，**章节顺序固定**：
   - ☀️ 天气：未来 24h 温度区间、降水概率峰值与时段、是否带伞、穿衣提示
   - 🏫 学校通知：只说**新增**里与本人相关的（放假/调课安排、奖助学金申报与发放、学籍培养、学位答辩、竞赛就业）；
     **放假类的具体日期/调课日期必须写清楚**（素材的「摘要」里有）；没有新增就写一行「无新增通知」。
     **每一条都要带素材里那条通知的链接（Markdown 链接 `[标题](url)`），不能只写标题**；
     通用安全须知、名单公示之类只做一句话概括，不要抄正文
   - 📰 AI 新闻：挑 5–6 条最有价值的（优先大模型/产品发布、开源与推理 Infra、行业与研究动向），每条一句话点评 + 链接
   - 💰 DeepSeek 余额：当前余额 + 是否偏低（<¥20 提醒充值）
   - 📄 论文：素材每个主题给了 **🆕 最新** 和 **🔥 最热** 两个榜单。
     优先从「🔥 最热」里挑（那是按 HF 点赞 + OpenAlex 被引排的，用户明确要求「按热度筛」），
     每个主题 1–2 篇，**每条都要带链接、热度单位（如 `54 👍`、`3 次被引`）和「完成单位」**，
     再给一句话点评（为什么值得看）；「最新」只在最热榜单为空或明显有新意时补位
     （「最热」条目的完成单位素材里已带；如果你选了「最新」里的论文，先跑
     `node <daily-report>/cli.mjs affil <arxiv-id>` 拿到机构再写进日报）
   - 🛠 Infra 动态：框架新版本、值得关注的新项目（没有就明说「无」）
   - 📌 项目进展：按仓库列 24–48h 的新 commit 与未提交改动，指出「卡在哪 / 下一步」
3. 把日报正文写入临时文件（如 `/tmp/daily-report-YYYY-MM-DD.md`）
4. 运行 `node $CLI publish --file <那个文件>` 写入飞书文档（当月文档不存在会自动创建）。
   **不用自己写日期标题**：publish 会加 `## YYYY-MM-DD HH:MM`、把栏目名统一成固定 7 个、
   按顺序排列，并把这条按**时间倒序**插到文档最上面；正文里也不要写落款/日期行
5. **最终回复 = 日报正文 + 链接块**（cron 任务会用 `--chat-id` 把它发到群），结尾固定加上：

   ```text
   📎 完整日报：<publish 输出里的 docUrl>
   📄 今日论文：
   - <论文标题> <arXiv 链接>
   - ...
   ```

   不要输出中间过程、不要复述工具原始输出。

## 每周 Paper Reading 文档（格式由代码保证，用户 2026-09-30 明确要求）

**格式不能靠模型"记得写"**，必须走代码。三段式：

```text
1) node $CLI paper <id> …          # 抓素材 → 落盘 materials.json（摘要/章节要点/图表图注+图片地址/完成单位/作者）
2) 写 spec.json                    # 每篇补齐：动机 / 方案 / 效果 / 关键结论 / 图表解读 / 对我的用处
3) node $CLI paperdoc --spec <spec.json> --enrich <materials.json> --check
   node $CLI paperdoc --spec <spec.json> --enrich <materials.json> --publish --name "Paper Reading <week>"
```

- spec 放 `~/.acp-claw/daily-report/paper-reading/<week>.json`（`config.paperReading.specDir`）
- **每篇必须有的字段**（缺任一 `paperdoc` 会直接报错退出，这是硬约束）：
  `url`（必须是 `https://arxiv.org/abs/<id>`，能点进去）/ `motivation` 动机 / `method` 方案 /
  `results` 效果 / `conclusion` 关键结论 / `figures`（至少 1 条，每条要有 `caption` 图注原文 + `explain` 解读）
- 栏目顺序、标题层级、速览表都由 `renderWeeklyDoc` 生成，**不要**自己拼 Markdown
- 图表：`--enrich` 把 `paper` 素材里的图片地址补进 spec；`paperdoc --publish` 会**先自己生成 .docx
  （图片按原始比例嵌入）再导入飞书**——不要改成直接传 Markdown，飞书的 Markdown 导入不下载外链图，
  只插占位图且会把图压扁（详见 tools/daily-report/README.md 的踩坑记录）
- `--publish` 用**用户身份**导入 → 新文档直接在你自己的云空间，不需要再共享
- 发布完记得把 `config.paperReading.docId` 改成新文档 id（否则批注还会去读旧的）
- 写「效果」时只能用素材里能查到的数字，**不要编造指标**

## 常见问题

- 采集项失败不会中断：素材顶部会列出失败项，日报里说明「某项数据缺失」即可
- 文档写不进去（`permission denied`/令牌过期）：按 feishu-doc skill 重新授权
- 想调整主题、地点、项目清单：改 `~/.acp-claw/daily-report/config.json`，不用改代码
- 想让上下文累积（例如需要跨天对比）：去掉 cron 任务的 `--fresh-session`

## AI 新闻（已并入每日简报）

AI 新闻与日报共用一套工具，**同一份简报里排在天气之后**，跟着 cron 任务「每日简报」的 07:00 / 12:00 / 18:00 三个时段一起出。

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs

node $CLI news                                     # 素材（标题/链接/时间/摘要）
node $CLI publish --file /tmp/ai-news-<日期>.md \
  --title "AI新闻 {yyyy}-{MM}" \
  --open-id ou_1e23742cb643e73a7e99196db2b80b8e    # 应用身份推送单聊（用户 open_id）
```

- 新闻源在 `config.json` 的 `news` 块：`feeds[]`（任意 RSS/Atom，可给 `keywords` 过滤、`windowHours` 单独放宽）+ `hackerNews`（走 HN Algolia，按标题命中 + `minPoints` 过滤）
- 默认源：量子位、雷峰网、Google AI Blog、OpenAI News、HuggingFace Blog（`hf-mirror.com`）、Hacker News
- 想单独把新闻推给自己：`publish --file <新闻.md> --title "AI新闻 {yyyy}-{MM}" --open-id <你的 open_id>`——用**应用身份**发单聊，并归档到独立的《AI新闻 YYYY-MM》文档（2026-09-16 曾用独立的 `AI新闻` cron 任务，现已并入日报）
- 想改时间/频率改 cron 任务的 `--schedule`，想改源改 `config.json` 的 `news`

## 学校通知（已并入每日简报）

面向「在读研究生关心的事」：放假通知、奖助学金、教学安排、培养学籍、学位答辩、竞赛就业。
源：信通学院（研究生科/教务科/学生科）、研究生院（重要公告/教学管理/学生管理/奖助学金/评奖评优/学位管理/就业实践）、学生工作部（站内搜索）。

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs
node $CLI school          # 默认 7 天窗口；只详列「新增」，其余只列一行
node $CLI school --json   # 给模型看：新增条数 / 各标签条数 / 每条标题链接
```

- **增量去重**：已报过的链接记在 `~/.acp-claw/daily-report/state.json` 的 `school.seen`（保留 90 天），
  所以同一份简报不管一天跑几次，都只报新通知；连续时段（07/12/18）不会重复轰炸
- 新增的重点通知（放假/奖助/教学/培养/学位）会自动带 450 字正文摘要，写简报时用它取具体日期与要求
- 调停课、监考、借教室这类常规通知被识别为「噪音」，只统计条数不进正文
- 改源/改标签改 `config.json` 的 `school` 块（`sources[]`、`tags[]`、`noise.keywords`、`fetchDetails`）
