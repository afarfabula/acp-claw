---
name: codex-cost
description: 统计 Codex 会话的 token 用量与人民币花费，含终端报表与每轮状态栏
trigger: 当用户询问 Codex 花了多少钱、token 用量、成本统计，或要安装/维护花费状态栏时
---

# Codex 花费统计（人民币）

数据来自本机 `~/.codex/sessions/**/rollout-*.jsonl` 里的逐轮 token 用量，按 DeepSeek
官方人民币价（含峰谷）换算。代码在仓库 `acp-claw/tools/codex-cost`，
工作区入口是软链接 `~/.acp-claw/tools/codex-cost`。

## 常用命令

```bash
node ~/.acp-claw/tools/codex-cost/cli.mjs summary    # 今天 / 本月 / 全部总览
node ~/.acp-claw/tools/codex-cost/cli.mjs daily 14   # 按日明细
node ~/.acp-claw/tools/codex-cost/cli.mjs sessions   # 花费最高的会话
node ~/.acp-claw/tools/codex-cost/cli.mjs price      # 当前时段单价与峰谷状态
node ~/.acp-claw/tools/codex-cost/cli.mjs install    # 安装每轮人民币状态栏
```

沙箱内可以直接运行（纯本地读文件，无网络），不需要提权。

## 回答用户时的要点

- 报花费一律用人民币，说明是**按官方单价估算**，不含优惠与赠送余额
- 状态栏的**本回合**＝这一次提问引发的全部请求之和（括号里是请求次数），与两次状态栏之间
  「会话」的差对得上；**不是**最后一次请求的花费。用户问「这轮到底花了多少」时报本回合
- 输入 token 里绝大部分是**缓存命中**（通常 98% 以上），所以真实花费远低于按未命中价估算
- 高峰时段为北京时间周一至周五 09:00–12:00、14:00–18:00，空闲时段半价；大批量任务建议错峰
- 价格或模型有变动时改 `pricing.mjs` 的 `PRICING` 与 `MODEL_ALIASES`
