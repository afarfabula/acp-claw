# GPU 监控（空闲卡提醒 + 历史表盘）

监控宿主机 8 张 RTX 3090 的占用情况：

- 每 30 秒采样一次 `nvidia-smi`
- 单卡 `util < 5%` **且** 显存占用 `< 5GB`，连续 3 分钟 → 通过飞书群 webhook 提醒空闲卡
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
    "consecutiveSamples": 6,
    "notifyRecovered": false
  },
  "server": { "host": "0.0.0.0", "port": 8808 },
  "dataDir": "data"
}
```

- `intervalMs`：采样间隔（默认 30s）
- `freeThreshold`：空闲判定阈值；`consecutiveSamples` 表示连续几次采样后通知
  （30s × 6 = 3 分钟）
- `notifyRecovered`：已提醒过空闲的卡被重新占用（连续占用约 3 分钟）时，再发一条「占用提醒」
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
- 服务重启后空闲判定会重新累计（已通知状态持久化在 `data/state.json`）
- 历史数据清理：直接删除 `data/` 下过期的 `samples-*.jsonl` 即可
