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
| 学术论文 | arXiv API + HF Daily Papers（含 `hf-mirror.com` 镜像）+ OpenAlex + arXiv HTML | 每个主题给**两个榜单**：🆕 最新（近 24h 提交）+ 🔥 最热（近 7 天，按「HF 点赞 + OpenAlex 被引」排序），热度值带单位；并抓**完成单位**（作者机构，解析 arXiv HTML 的作者块） |
| Infra 动态 | GitHub API | 关注仓库的新 release、近期高星新项目、账号下的 push 事件 |
| 项目进展 | 本地 `git log/status` + GitHub 事件 | “用最新 commit 当记忆”，含未提交改动数量 |
| AI 新闻 | RSS/Atom 多源 + HN Algolia API | 量子位/雷峰网/Google AI/OpenAI/HuggingFace Blog + Hacker News（按热度过滤），去重 + 时间窗 |
| 学校通知 | 研究生院 / 信通学院 / 学生工作部 | 放假通知、奖助学金、教学安排、培养学籍、学位答辩、就业竞赛；按标签分类 + 增量去重（默认只报新出现的） |

## 用法

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/daily-report/cli.mjs

node $CLI collect                     # 采集素材：打印 Markdown，落盘 data/<日期>.json 与 <日期>-brief.md
node $CLI collect --json              # 只打印落盘路径
node $CLI news                        # 采集 AI 新闻素材：落盘 data/<日期>-news.json 与 <日期>-news.md
node $CLI news --json                 # 只打印路径、条数与各源成功/失败状态
node $CLI school                      # 采集学校/学院通知素材（默认 7 天窗口，标记已读，只详列新增）
node $CLI school --json               # 只打印路径、新增条数与各源状态
node $CLI school --days 30            # 放宽时间窗（首次跑建议大一点，把历史一次记进已读）
node $CLI school --all                # 忽略已读状态，全部当作新增（调试用，不更新已读）
node $CLI school --no-detail          # 不抓正文摘要（更快，只用标题）
node $CLI publish --file <日报.md>     # 写入飞书文档（按 config.feishu.docTitlePattern 自动建/找当月文档）
node $CLI publish --file <日报.md> --chat oc_xxx   # 同时用应用身份发一份到群
node $CLI publish --file <新闻.md> --title "AI新闻 {yyyy}-{MM}" --open-id ou_xxx  # 归档 + 单聊推送
node $CLI doc-tree                    # 解析文档里的简报条目（日期/栏目/首行），不改文档
node $CLI affil 2606.05688 2609.35457 # 查论文的完成单位（机构/团队）与作者
node $CLI doc-tree --file <md>        # 同上，但读本地 Markdown（离线排查用）
node $CLI fixdoc --dry                # 预览「重排 + 规范化」结果（备份原稿并落盘规范化稿）
node $CLI fixdoc                      # 重排/规范化当月文档（先备份，再整体重写）
node $CLI fixdoc --fixes <json>       # 额外按 json 里的规则改日期 / 丢重复条目
node $CLI config                      # 查看运行时配置
```

## 配置

运行时配置放在仓库之外：`~/.acp-claw/daily-report/config.json`（可用 `DAILY_REPORT_HOME` / `DAILY_REPORT_CONFIG` 覆盖）。
不存在时会退回仓库内的 [config.example.json](./config.example.json)。常用字段：

- `weather.latitude/longitude/name/hours`：地点与预报时长
- `papers.arxiv[]`：主题 + arXiv 查询串
- `papers.latestHours`（默认 24）：「最新」窗口；`papers.hotDays`（默认 7）：「最热」窗口
- `papers.latestPerTopic` / `papers.hotPerTopic` / `papers.hotMinScore`：两个榜单的条数与热度门槛
- `papers.maxResults`（默认 300）、`papers.topicGapMs`（默认 3200ms）、`papers.retries`：arXiv 抓取的量、请求间隔与重试（arXiv 会 429 限流，连续查询时必须留间隔）
- `papers.heat.upvoteWeight`（默认 5）：HF 点赞在热度里的权重；`papers.heat.openalex.mailto`：OpenAlex 礼貌池联系邮箱
- `papers.hfDailyPapers`：HF 热榜（`base` 可指向镜像，`days` 默认 7：往回抓几天的点赞用于热度）
- `papers.affiliation`：完成单位抓取（`enabled` 默认开，`maxPapers` 默认 8 只抓「最热」榜、`gapMs` 请求间隔）——
  数据来自 arXiv HTML 版作者块；2023-12 以前、或作者块被转换弄坏的论文可能取不到（此时用 `affil` 命令单独试）
- `infra.releases[]`：关注的 GitHub 仓库；`infra.trending`：近期高星新项目
- `news.feeds[]`：新闻源（`label`/`url`/`limit`，可选 `keywords`、`windowHours`）；`news.hackerNews`：HN Algolia 关键词、`minPoints`、时间窗
- `projects.local[]`：本地仓库（`name` + `path`）；`projects.github.user`：账号级 push 事件
- `feishu.docTitlePattern`：日报文档标题模板，支持 `{yyyy}` `{MM}` `{date}` `{month}`
- `feishu.chatId`：默认群（`publish --chat` 未指定时不会自动使用，交给 cron 任务的 `--chat-id`）

## 学校通知（`school`）

面向「在校生关心的事」做的采集，默认盯这几类源：

| 站点 | 栏目 | 解析器 |
| --- | --- | --- |
| 信通学院（`www.sice.uestc.edu.cn`） | 研究生科 / 教务科 / 学生科 | `vsb`（学院 CMS：`li > a > div.p-date + p`） |
| 研究生院（`gr.uestc.edu.cn`） | 重要公告 / 教学管理 / 学生管理 / 奖助学金 / 评奖评优 / 学位管理 / 就业实践 | `gr`（`div.title > a` + `div.time`） |
| 学生工作部（`xgb.uestc.edu.cn`） | 站内搜索「奖学金 / 助学金 / 放假」 | `xgbSearch`（搜索页服务端渲染；明细页是 SPA，故不抓正文） |

处理逻辑：

1. 每个源独立抓取、独立失败（失败只体现在素材顶部的「失败项」里）
2. 按 `tags[].keywords` 给标题打标签（放假/节假日、奖助学金/评优、教学/课程/考试、培养/学籍/报到、学位/答辩/毕业、就业/实习/竞赛、讲座/活动）
3. 命中 `noise.keywords` 的通知（调停课、监考、借教室…）归入「常规通知」，只统计条数
4. **增量去重**：已报过的链接记在 `state.json` 的 `school.seen`（默认保留 90 天），素材只详列「新增」，其余只列一行备查
5. 新增且属于重点标签的通知，会顺带抓一次正文，截前 450 字放进素材（`fetchDetails`）

素材里每条都带 `链接：` 行（原文地址），写简报时必须把它带上——群里只有可点击链接才有用。

常用配置（`~/.acp-claw/daily-report/config.json` 的 `school` 块）：

- `windowDays`：时间窗（默认 7 天）
- `sources[]`：`site`/`label`/`url`/`parser`（`vsb` | `gr` | `xgbSearch`）、`{enabled:false}` 可临时停掉某个源
- `tags[]`：`{label, emoji, keywords}`，按顺序取第一个命中项做分组
- `noise.keywords`：低价值通知关键词
- `fetchDetails`：`{enabled, max, maxChars}` 控制正文抓取的条数与长度
- `detailTags`：哪些标签需要抓正文

> 首次跑建议 `node $CLI school --days 30`，把近一个月的存量一次性标记为已读，之后每天就只报真正的新通知。

## 投递说明

- 写文档走 `tools/feishu-doc`（用户身份，令牌在 `~/.acp-claw/feishu-doc-data/user-token.json`），因此在飞书里看到的是「你写的」文档
- 发群消息走应用身份（`im/v1/messages`），要求机器人已在该群里
- 日报正文默认由 cron 任务的最终回复发到群里，`publish --chat` 只是备用通道
- 个人推送用 `publish --open-id <open_id>`（应用身份单聊），适合「AI 新闻」这类只发给自己的简报

## 文档格式规范（2026-09-29 起）

模型每天写的内容长短不一，为了让文档可读、可检索，`publish` 会先**规范化**再写入：

- 每条简报固定为二级标题 `## YYYY-MM-DD HH:MM`；下面固定 7 个三级标题栏目，
  顺序固定：☀️ 天气 → 🏫 学校通知 → 📰 AI 新闻 → 💰 DeepSeek 余额 → 📄 论文 → 🛠 Infra 动态 → 📌 项目进展
- **按时间倒序**：最新一条永远在文档最上面（`publish` 读出文档结构、算出插入位置，
  不再是无脑追加到文末）；同一天同一分钟重复推送会**覆盖**旧的那条，不留两份
- 栏目名容错：`**💰 DeepSeek 余额**`、`💰 DeepSeek 余额：……`、`### 📄 论文` 这类写法都会被识别并统一；
  正文里重复的栏目名前缀、模型自己加的落款行（`每日简报 2026-09-20（18:00 更新）`）会被去掉
- 历史文档如果已经乱了（顺序错、标题级别不一），用 `fixdoc` 一键重排：
  先把原稿备份到 `~/.acp-claw/daily-report/backups/doc-<日期>-<时间>-raw.md`，再把规范化结果整体写回
- 个别条目缺少日期标题时，`fixdoc` 按前后条目推断（07/12/18 槽位）；确实推断不出来的，
  可以写进 `doc-fixes.json`（`{"dates": [{"match": "正文片段", "stamp": "YYYY-MM-DD HH:MM"}], "drop": ["正文片段"]}`）
  用 `--fixes` 指定

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
