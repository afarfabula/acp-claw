---
name: feishu-doc
description: 飞书云文档读写，支持创建文档、追加 Markdown、读取内容、定位并修改块、添加协作者
trigger: 当用户需要在飞书文档里写入内容、修改文档、创建文档、读取飞书文档或查看文档结构时
---

# 飞书云文档操作

## Purpose

通过 `acp-claw/tools/feishu-doc/cli.mjs` 读写飞书云文档。支持两种身份：

- **用户身份**（推荐，已授权）：能搜索、读取、编辑该用户云空间里的文档。令牌存在时自动使用
- **应用身份**（tenant_access_token）：只能操作应用自己创建的、或被共享给应用的文档

身份选择：默认「有用户令牌就用用户身份」，可用 `FEISHU_TOKEN_MODE=tenant|user` 强制指定。

## 代码来源

- 本 skill 与 CLI 的源文件维护在仓库 `acp-claw` 中：
  - `tools/feishu-doc/`（CLI 与脚本）
  - `skills/feishu-doc/SKILL.md`（本文件）
- 运行时目录 `/home_ext/quyanyi/.acp-claw/tools/feishu-doc` 与 `/home_ext/quyanyi/.acp-claw/skills/feishu-doc` 是指向仓库的软链接，改代码请改仓库里的文件

## 前置条件

- 应用凭据取自 `/home_ext/quyanyi/.acp-claw/config.json` 的 `feishu.appId/appSecret`
- 已开通权限：应用身份 `docx:document` + `drive:drive`；用户身份同上（含 `offline_access`）
- 用户令牌文件：`~/.acp-claw/feishu-doc-data/user-token.json`（**在仓库之外**，避免误提交；可用 `FEISHU_DATA_DIR` 覆盖）
- 令牌有效期：access 2 小时自动刷新，refresh 30 天
- 令牌失效后需重新授权：`node login.mjs --url` 打印授权链接，用户浏览器打开后把跳转地址里的 `code=` 发给 AI，执行 `node login.mjs <code>`
- 沙箱内不能联网，运行本 CLI 需要提权执行（sandbox escalation）

## Commands

```bash
CLI=/home_ext/quyanyi/.acp-claw/tools/feishu-doc/cli.mjs
node $CLI read <doc_id|url>                 # 读纯文本
node $CLI meta <doc_id|url>                 # 读标题/版本
node $CLI blocks <doc_id|url>               # 列出块（含 block_id，便于定点修改）
node $CLI create --title <标题> [--folder <folder_token>]
node $CLI append <doc_id|url> --md <markdown>      # 追加 Markdown（也支持 --md @文件路径）
node $CLI update-block <doc_id> <block_id> --text <文本>
node $CLI delete-block <doc_id> <block_id> --parent <parent_block_id> [--index N]
node $CLI list [--folder <folder_token>]   # 列出云空间文件
node $CLI search <关键词> [--count N]       # 搜索云文档（用户身份下才有意义）
node $CLI wiki-search <关键词>              # 搜索知识库节点（知识库里的文档只能用这个搜到）
node $CLI share <doc_id|url> --member <open_id|email> [--member-type open_id] [--perm view|edit]
node $CLI delete <doc_id|url>              # 删除文档（移入回收站）
```

## Behavior

- `append` 默认用**本地转换器**把 Markdown 转成文档块（支持标题 / 段落 / 有序无序列表 / 引用 / 代码块 / 分隔线 / `**加粗**` / `` `行内代码` ``），插入到文档末尾；加 `--use-convert` 才走飞书 convert 接口（该接口需要额外权限 `docx:document.block:convert`，用户身份通常没有）
- `update-block` 会先查询块的类型，再按类型选择对应的更新字段（text/heading1-3/bullet/ordered/code/quote）
- `blocks` 输出格式：`block_id  type=N(类型)  文本内容`，用于定位要修改的块
- 文档链接形如 `https://feishu.cn/docx/<document_id>`，CLI 会自动从链接里提取 ID
- 修改已有段落：先用 `blocks` 找到目标 `block_id`，再用 `update-block` 覆盖内容

## 常见错误

- `code=99991672 ... scopes is required`：应用身份权限没开通，需在飞书开放平台补齐并发布版本
- `code=1770002 / permission denied`：应用对该文档没有权限，需要把文档共享给应用，或改用应用创建的文档
- 沙箱内 `curl`/网络报错：属正常限制，用提权方式执行
