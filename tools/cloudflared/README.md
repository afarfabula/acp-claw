# Cloudflare Tunnel

仓库只保存脱敏模板。真实 tunnel ID、credential 文件路径和域名配置放在本机
`config.yml`（已被 `.gitignore` 排除），不要提交。

首次部署：

```bash
cp config.example.yml config.yml
# 填入本机 tunnel ID、credentials-file 和 ingress hostname
./deploy.sh
```

## 路由

| 域名 | 本地服务 |
| --- | --- |
| `home.example.com` | `127.0.0.1:8080` |
| `code.example.com` | `127.0.0.1:8818` |
| `gpu.example.com` | `127.0.0.1:8808` |
| `overleaf.example.com` | `127.0.0.1:51007` |
| `resume.example.com` | `127.0.0.1:8820` |

## 部署

```bash
cd ~/acp-claw/tools/cloudflared
./deploy.sh
```

脚本会：

1. 将 `~/.cloudflared` 顶层配置备份到 `backup-<日期>-<时间>/`。
2. 从本机 `config.yml` 读取 tunnel ID 和 ingress hostname，并用
   `--overwrite-dns` 更新 DNS。
3. 安装 canonical `config.yml` 和用户级 systemd unit。
4. 停止旧的孤儿 `code-ide` 进程并重启统一 tunnel。用户 systemd bus
   可用时交给 systemd，否则退回 `nohup` 并记录 pid。

## 运维

```bash
systemctl --user status cloudflared
journalctl --user -u cloudflared -f
systemctl --user restart cloudflared
```

若当前登录会话的 user systemd bus 失效，可使用：

```bash
kill -TERM -- "-$(cat ~/.cloudflared/cloudflared.pid)"
cd ~/acp-claw/tools/cloudflared && ./deploy.sh
```

回滚时从最近备份目录恢复 `config.yml`，然后执行：

```bash
systemctl --user daemon-reload
systemctl --user restart cloudflared
```
