# codex-cost —— Codex 会话花费统计（人民币）

把 Codex 每轮的 token 用量按 **DeepSeek 官方人民币价格**换算成钱：既能在终端里出报表，
也能作为 Codex 的 Stop hook，在**每轮回答结束时**把「这一问花了多少钱 / 会话累计」直接
显示在回答后面。

## 为什么不用现成工具

社区里 `token-tracker`、`ccusage` 都能统计 Codex 用量，但它们的 DeepSeek 价格表是旧价：
flash 按 ¥3 / ¥9 / ¥0.1（未命中 / 输出 / 缓存命中）计，而官方现价（2026-09）是
**¥2 / ¥8 / ¥0.04**。因为 Codex 的输入 99% 是缓存命中，用旧价会把花费**高估约 1.7 倍**。
本项目直接内置官方价，并支持峰谷两档，所以显示的就是真实账单口径。

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

## 已知限制

- 只按 token 单价估算，不含赠送余额、优惠券、批量折扣；与 DeepSeek 后台账单口径一致但
  **不是**账单本身
- 非 DeepSeek 模型（OpenAI 等）目前按 flash 价兜底，需要时在 `PRICING` 里补
- 报表需要扫描 `~/.codex/sessions`（当前 40MB 级别，秒级完成）；会话量再涨一个量级时
  可加缓存或改读 `state_5.sqlite`
