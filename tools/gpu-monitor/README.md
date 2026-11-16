# GPU 监控（空闲卡提醒 + 历史表盘）

监控宿主机 8 张 RTX 3090 的占用情况：

- 每 30 秒采样一次 `nvidia-smi`
- 单卡空闲判定：`util < 5%` **且** 显存占用 `< 5GB`
- **空闲提醒**：同时空闲的卡 ≥ `minFreeCards`（默认 4 张）并连续保持
  `consecutiveSamples` 次采样（默认 40 次 × 30s = 20 分钟）→ 飞书群 webhook 提醒这几张卡可以用
- **占用提醒**：发出空闲提醒之后，空闲卡数掉到 `minFreeCards` 以下并连续保持
  `recoverConsecutiveSamples` 次采样（默认同为 20 分钟）→ 再提醒一次，
  并附上被占用卡的用户名 + 进程命令行
- 历史数据按天写入 `data/samples-YYYY-MM-DD.jsonl`
- 浏览器表盘 + 终端视图

## 启动

```bash
cd tools/gpu-monitor
node service.mjs                 # 常驻：采样 + 提醒 + 表盘 API（默认 :8808）
```

开机自启（可选）：

```bash
sudo cp gpu-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gpu-monitor
```

## 配置（config.json）

```json
{
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
  "intervalMs": 30000,
  "freeThreshold": {
    "util": 5,
    "memGb": 5,
    "minFreeCards": 4,
    "consecutiveSamples": 40,
    "recoverConsecutiveSamples": 40,
    "notifyRecovered": true
  },
  "server": { "host": "0.0.0.0", "port": 8808 },
  "dataDir": "data"
}
```

- `intervalMs`：采样间隔（默认 30s）
- `freeThreshold.util` / `.memGb`：单卡空闲判定（util 百分比、显存 GB）
- `freeThreshold.minFreeCards`：一次提醒要求的最少空闲卡数（默认 4；设为 1 即退回“任意单卡空闲就提醒”）
- `freeThreshold.consecutiveSamples`：空闲提醒需要连续多少次采样（30s × 40 = 20 分钟）
- `freeThreshold.recoverConsecutiveSamples`：占用提醒需要连续多少次采样（默认同 20 分钟）
- `freeThreshold.notifyRecovered`：是否发送「占用提醒」（发出空闲提醒后，空闲卡不足 `minFreeCards`
  并持续达标才发；会附上占用者的 Linux 用户名与该卡上的进程命令行）
- 提醒按**同时空闲的卡数**判断，一次事件只发一条；状态机实现见 `alert-state.mjs`
- `server.host/port`：表盘 HTTP 服务；默认监听 0.0.0.0，内网可访问

> webhook 地址视为密钥，`config.json` 已被 gitignore，仓库里只保留
> `config.example.json` 模板。

## 表盘（浏览器）

打开 `http://<host>:8808`：

- 顶部实时表格：8 卡利用率/显存/温度 + 空闲徽章
- 利用率/显存折线图：30 分钟 ~ 24 小时可切换，点击图例可隐藏 GPU
- 每 10 秒自动刷新

## 终端视图

```bash
node dash.mjs matrix              # 当前矩阵快照
node dash.mjs live                # 实时表格 + 最近 60 分钟 ASCII 曲线
node dash.mjs summary --hours 24  # 每张卡均值/峰值/空闲占比
node dash.mjs health              # 服务健康检查
node service.mjs --state          # 查看当前空闲卡数与提醒状态机进度（不发消息）
node test-alert-state.mjs         # 提醒状态机单测
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/latest` | 当前 8 卡矩阵 + 空闲状态 |
| `GET` | `/api/history?minutes=60` | 历史序列（1 分钟粒度，自动降采样） |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/` | 表盘页面 |

## 故障处理

- 采样失败（`nvidia-smi` 不可用）：静默重试，不误报，`/api/health` 会显示 `lastError`
- 服务重启后空闲判定会重新累计（提醒状态持久化在 `data/state.json`，v2 格式含台数状态机）
- 历史数据清理：直接删除 `data/` 下过期的 `samples-*.jsonl` 即可
