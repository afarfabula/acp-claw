# GSM Page

实习展示页，监听 `127.0.0.1:8820`。原路径 `~/gsm-page` 保留为指向本目录的软链。

## 启动与停止

```bash
cd ~/acp-claw/tools/gsm-page
JSM_PASSWORD='choose-a-strong-password' ./start.sh
./stop.sh
```

密码必须通过 `JSM_PASSWORD` 环境变量注入，不提供默认值；未设置时服务会拒绝启动。

```bash
JSM_PASSWORD='new-password' ./start.sh
```

日志和 PID 文件位于 `~/.local/state/acp-claw/`。
