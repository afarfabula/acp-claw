# GSM Page

实习展示页，监听 `127.0.0.1:8820`。原路径 `~/gsm-page` 保留为指向本目录的软链。

## 启动与停止

```bash
cd ~/acp-claw/tools/gsm-page
./start.sh
./stop.sh
```

默认密码为 `JSMZKAL`。可通过环境变量覆盖：

```bash
JSM_PASSWORD='new-password' ./start.sh
```

日志和 PID 文件位于 `~/.local/state/acp-claw/`。
