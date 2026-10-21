# Home Portal

统一门户，监听 `127.0.0.1:8080`，由 Cloudflare Tunnel
以 `home.afarfabula.org` 对外提供服务。

## 启动与停止

```bash
cd ~/acp-claw/tools/home-portal
./start.sh
./stop.sh
```

日志和 PID 文件位于 `~/.local/state/acp-claw/`。

## 检查

```bash
curl http://127.0.0.1:8080/health
curl https://home.afarfabula.org/health
```
