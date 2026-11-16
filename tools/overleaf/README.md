# Overleaf Community Edition

本机没有 Docker socket 权限，也没有 sudo，因此实际运行采用 NVIDIA Enroot：

- 无 root、无 setuid helper；
- 固定 Overleaf CE `6.3.1`；
- MongoDB `8.0`、Redis `6.2`；
- 所有运行时与数据位于 `/home_ext/quyanyi/overleaf-data`；
- 本机只监听 `127.0.0.1:51007`，公网由 Cloudflare Tunnel 提供。

`docker-compose.yml` 和 `Dockerfile` 是官方社区版部署的等价配置与升级基准。
当前机器使用 `start.sh` 通过 Enroot 执行同样的镜像和参数。

`start.sh` 固定传入 `--pid`，让 Overleaf 的 `my_init` 只能清理自己的容器进程；
不要移除该参数，否则停服时会误伤同用户下的其他服务。

## 首次安装

```bash
cd ~/acp-claw/tools/overleaf
./install-runtime.sh
./upgrade.sh
./start.sh
```

Overleaf 初始管理员通过以下地址一次性创建：

```text
https://overleaf.afarfabula.org/launchpad
```

管理员占位邮箱写在 `.env` 的 `OVERLEAF_ADMIN_EMAIL`。首个管理员创建完成后，
`/launchpad` 会跳转登录页，`/register` 只显示联系管理员，不再公开注册。

本次部署已创建唯一管理员：

```text
display name: quyanyi
email: quyanyi@afarfabula.org
credentials: /home_ext/quyanyi/overleaf-data/admin-credentials.txt
```

邮箱是占位值，登录后可在 Account Settings 中修改。密码文件权限为 `0600`，
也应在首次登录后立即更换。

## TeX Live 全量宏包

Enroot 首次启动后，在 Overleaf 容器内执行：

```bash
cd ~/acp-claw/tools/overleaf
source ./enroot-env.sh
enroot start --root --rw "overleaf-$OVERLEAF_VERSION" \
  sh -c 'tlmgr install scheme-full && tlmgr path add'
```

该步骤会占用较多磁盘和下载时间，脚本 `install-texlive-full.sh` 已封装。

## 启停与状态

```bash
./start.sh
./stop.sh
./status.sh
tail -f /home_ext/quyanyi/overleaf-data/logs/overleaf.log
```

## 升级

```bash
# 修改 .env 中的 OVERLEAF_VERSION 后
./stop.sh
./upgrade.sh
./start.sh
```

升级会重新拉取固定版本镜像。现有数据位于
`/home_ext/quyanyi/overleaf-data/{sharelatex,mongo,redis}`，不会放入 Git 仓库。
