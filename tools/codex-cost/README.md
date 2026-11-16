# codex-cost —— Codex 花费 / 火山方舟 Coding Plan 额度

Codex 现在通过本机 `ark-codex-router` 同时挂两套计费，本工具按**模型名分流**后给出对应口径：

| 车道 | 模型名规则 | 计费方式 | 状态栏显示 |
|---|---|---|---|
| 火山方舟 Coding Plan（包月额度） | 不以 `dsapi-` 开头，如 `deepseek-v4.1-flash` | 套餐额度（5 小时 / 本周 / 本月） | 套餐额度百分比 + 重置时间 |
| DeepSeek 官网 API（按量） | 以 `dsapi-` 开头，如 `dsapi-deepseek-chat` | 按 token 计费 | 本回合 / 会话人民币 |

套餐额度是**线上数据**：工具直接调本机 `arkcli` 读火山方舟控制面，跟控制台「我的套餐」
1:1，不是本地估算。DeepSeek 车道仍按官方人民币价目表估算（见下方「计价规则」）。

Codex 的 Stop hook 会在**每轮回答结束时**把状态栏追加到回答后面；终端里也能出报表。

## 火山方舟 Coding Plan 额度

```bash
node ~/.acp-claw/tools/codex-cost/cli.mjs plan         # 5 小时 / 本周 / 本月额度快照
node ~/.acp-claw/tools/codex-cost/cli.mjs plan --json  # 直接吐 arkcli 原始 JSON
node ~/.acp-claw/tools/codex-cost/cli.mjs plan --all   # 展开全部 4 个套餐 SKU（诊断）
```

数据来自 `arkcli usage plan --product coding-plan --format json`，**需要 arkcli 已登录**
（`arkcli auth login`）。要点：

- `session` 周期就是常说的 **5 小时窗口**：从窗口起点滚动计时，用满会限流，
  到 `reset_at` 时刻自动刷新；`weekly` / `monthly` 是本周 / 本月总盘。
- Coding Plan 后端只保证返回**百分比**（`percent`），不一定给绝对值 `used/total`，
  所以状态栏按百分比画进度条。
- 未登录 / 查询失败时状态栏**静默跳过**这一行（不让状态栏变噪音），想看失败原因就跑
  `cli.mjs plan`。

状态栏（Coding Plan 车道）长这样：

```
[项目] | 本回合 3 次请求 · 118k tok | 会话 1.2M tok | deepseek-v4.1-flash
套餐 5小时  82% ████████░░（18:35 重置）  本周  21% ██░░░░░░░░  本月   9% █░░░░░░░░
上下文 57k/996k █░░░░░░░ 6% | 缓存命中 98.6% | 0/3 轮高峰
```

读取带 120s TTL 缓存（每轮都读，但不每轮都发网络请求）；可用 `CODEX_COST_CACHE`
改缓存目录，`ARKCLI_BIN` 指定 arkcli 可执行文件。

## 为什么不用现成工具

社区里 `token-tracker`、`ccusage` 都能统计 Codex 用量，但它们的 DeepSeek 价格表是旧价：
flash 按 ¥3 / ¥9 / ¥0.1（未命中 / 输出 / 缓存命中）计，而官方现价（2026-09）是
**¥2 / ¥8 / ¥0.04**。因为 Codex 的输入 99% 是缓存命中，用旧价会把花费**高估约 1.7 倍**。
本项目直接内置官方价，并支持峰谷两档，所以显示的就是真实账单口径。

DeepSeek 车道保留这套价格表；火山方舟 Coding Plan 车道不看单价，只看上面那份套餐额度。

## 计价规则

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（元 / 百万 token）

| 模型 | 时段 | 缓存未命中输入 | 输出 | 缓存命中输入 |
|---|---|---|---|---|
| deepseek-flash | 高峰 | ¥2 | ¥8 | ¥0.04 |
| deepseek-flash | 空闲 | ¥1 | ¥4 | ¥0.02 |
| deepseek-v4-pro | 高峰 | ¥9 | ¥27 | ¥0.30 |
| deepseek-v4-pro | 空闲 | ¥4.5 | ¥13.5 | ¥0.15 |

- **高峰**：北京时间周一至周五 09:00–12:00、14:00–18:00；其余时段与周末全天为空闲（半价）
- 每轮用量取自会话记录里的 `token_count` 事件（`info.last_token_usage`），
  模型取自同文件的 `turn_context.model`，因此**按每轮实际时刻**判峰谷，跨时段会话不会算错
- `cached_input_tokens` 是 `input_tokens` 的子集（缓存命中量），未命中 = 输入 − 命中

## 使用

```bash
node ~/.acp-claw/tools/codex-cost/cli.mjs summary     # 今天 / 本月 / 全部
node ~/.acp-claw/tools/codex-cost/cli.mjs daily 14    # 按日明细
node ~/.acp-claw/tools/codex-cost/cli.mjs sessions    # 花费最高的会话
node ~/.acp-claw/tools/codex-cost/cli.mjs plan        # Coding Plan 额度（线上）
node ~/.acp-claw/tools/codex-cost/cli.mjs price       # 当前时段单价
```

`~/.acp-claw/tools/codex-cost` 是指向本仓库的软链接，改代码请改仓库里的文件。

## 状态栏（Stop hook）

```bash
node ~/.acp-claw/tools/codex-cost/cli.mjs install     # 写入 ~/.codex/hooks.json
```

安装后需要在 Codex 里执行一次 `/hooks` 信任该 hook（Codex 对非托管 hook 默认不信任），
之后每轮回答结束会追加两行：

```
[项目] | 本回合 ¥0.078 (4 次请求) | 会话 ¥0.86 | 累计 5.6M tok | deepseek-flash
上下文 57k/996k █░░░░░░░ 6% | 缓存命中 98.6% | 3/12 轮高峰
```

（DeepSeek 车道。Coding Plan 车道把第一行的人民币换成「请求数 + token 量」，并多出一行
套餐额度，见上文示例。）

- **本回合** = 你这一次提问引发的全部请求之和。Codex 的一次回答是「模型 → 工具 → 模型 →
  … → 模型」的循环，每次工具调用后都要重发上下文再请求一次并单独计费，所以一次回答
  往往是多次请求；括号里就是次数。它的口径与「两次状态栏之间会话值的差」一致。
- **会话** = 该会话至今的累计花费；**累计** = 会话内输入 + 输出 token。
- 第二行三项都只描述**最后一次请求**（上下文占用 / 该次缓存命中率 / 该次是否高峰），
  用来判断是否需要重置会话或错峰，不是回合汇总。
- 会话记录里没有 `task_started`（回合边界）时退回显示 `本轮 ¥X`，表示只有最后一次请求。

输出走 Codex 的 `systemMessage`，只渲染在界面上，**不进入模型上下文**，不额外消耗 token。

```bash
node cli.mjs status       # 查看当前 hook 配置
node cli.mjs uninstall    # 卸载（只删本工具写入的条目，写入前自动备份 hooks.json）
```

安装脚本会顺手清掉 `token-tracker` 的 `codex-statusline.py` 伪状态栏，避免一轮出现两行；
它的 `UserPromptSubmit`（侧边栏）保持不动。

## 扩展

- **改价**：编辑 `pricing.mjs` 里的 `PRICING`，按「元 / 百万 token」写峰谷两档即可
- **新模型**：在 `PRICING` 加一条；退役名或别名加到 `MODEL_ALIASES`（例如
  `deepseek-v4-flash` → `deepseek-flash`）
- **峰谷时段变化**：改 `isPeak()`；单位是北京时间，用固定 +8 偏移换算（中国无夏令时）
- **套餐额度**：`plan.mjs` 负责调 arkcli、解析、缓存、渲染。换产品（如 `agent-plan`）改
  `CODING_PLAN_PRODUCT`；换车道前缀规则改 `laneRules()`（默认读
  `~/.codex/router/config.json` 的 `prefix_routes`，读不到时退回 `dsapi-` 前缀约定）

## 已知限制

- 只按 token 单价估算，不含赠送余额、优惠券、批量折扣；与 DeepSeek 后台账单口径一致但
  **不是**账单本身
- Coding Plan 额度是控制面**快照**，有聚合延迟；它反映「套餐用了百分之几」，不是
  实时预算 / 限流数据源
- 非 DeepSeek 模型（OpenAI 等）目前按 flash 价兜底，需要时在 `PRICING` 里补
- 报表需要扫描 `~/.codex/sessions`（当前 40MB 级别，秒级完成）；会话量再涨一个量级时
  可加缓存或改读 `state_5.sqlite`
