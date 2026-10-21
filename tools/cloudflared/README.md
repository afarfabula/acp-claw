# Cloudflare Tunnel

统一使用 tunnel `4f3d2630-c3c3-40d0-8587-229e8840132d`
（名称 `code-ide`）。SSH 两个 hostname 已从隧道中移除。

## 路由

| 域名 | 本地服务 |
| --- | --- |
| `home.afarfabula.org` | `127.0.0.1:8080` |
| `code.afarfabula.org` | `127.0.0.1:8818` |
| `3090gpu.afarfabula.org` | `127.0.0.1:8808` |
| `overleaf.afarfabula.org` | `127.0.0.1:51007` |
| `resume.afarfabula.org` | `127.0.0.1:8820` |

## 部署

```bash
cd ~/acp-claw/tools/cloudflared
./deploy.sh
```

脚本会：

1. 将 `~/.cloudflared` 顶层配置备份到 `backup-<日期>-<时间>/`。
2. 用 `--overwrite-dns` 将五个域名指向 tunnel `4f3d2630`。
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
