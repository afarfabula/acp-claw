# Overleaf Git Bridge

项目级双向 Git bridge。Overleaf 项目仍是普通网页项目，本地 Git 通过文件系统
remote 与它同步。

## 工作方式

- 本地 `git push overleaf <branch>`：`pre-receive` 钩子把提交快照写入 Overleaf。
- Overleaf 网页发生修改：poller 导出项目、生成 commit 并更新 bare repo。
- 本地 `git pull overleaf <branch>`：获取 Overleaf 产生的 commit。
- 本地 Git 与 Overleaf 都保留内容，因此不是物理单副本，但本地只有这一份工作目录。

当前项目：

- Overleaf project: `6ad89286858a0825937c92f2`
- Local working tree: `/home/quyanyi/tiger/resume`
- Git branch: `master`
- Bare repo: `/home_ext/quyanyi/overleaf-data/git-bridge/projects/6ad89286858a0825937c92f2.git`

## 启停

```bash
cd ~/acp-claw/tools/overleaf-git
./start.sh
./stop.sh
./status.sh
```

日志：`/home_ext/quyanyi/overleaf-data/git-bridge/bridge.log`

## 使用

```bash
cd /home/quyanyi/tiger/resume
git remote add overleaf \
  /home_ext/quyanyi/overleaf-data/git-bridge/projects/6ad89286858a0825937c92f2.git
git push overleaf master
git pull overleaf master
```

Bridge 只监听本机文件访问，不开放 TCP 端口。项目 ID、路径和轮询周期在
`projects.json` 中配置。
