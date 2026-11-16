# Overleaf File Sync

双向文件同步工具，位于 `acp-claw/tools/overleaf-sync/`。

## 行为

- Overleaf 网页修改会在轮询周期（默认 5 秒）内写回本地 Git 工作目录。
- 本地文件修改会自动同步回同一个 Overleaf 项目。
- 两端同时修改同一文件时，本地版本保留，远端版本写入
  `.overleaf-conflict/<时间>/`，不会静默覆盖。
- 内容哈希未变化时不会删除或重新上传项目文件。
- `.git`、`.gitignore`、PDF 和 LaTeX 编译中间文件不参与 Overleaf 同步。

## 启停

```bash
cd ~/acp-claw/tools/overleaf-sync
./start.sh
./stop.sh
./status.sh
```

配置：`projects.json`
状态：`/home_ext/quyanyi/overleaf-data/overleaf-sync/state.json`
日志：`/home_ext/quyanyi/overleaf-data/overleaf-sync/sync.log`
