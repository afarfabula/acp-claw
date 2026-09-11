# 飞书云文档工具（feishu-doc）

让 agent 以**用户身份**或**应用身份**读写飞书云文档 / 知识库，配套 skill 见
[`skills/feishu-doc/SKILL.md`](../../skills/feishu-doc/SKILL.md)。

## 能力

| 命令 | 说明 |
| --- | --- |
| `read <doc\|url>` | 读取文档纯文本（支持 docx / wiki 链接） |
| `meta <doc>` / `blocks <doc>` | 文档信息 / 块列表（含 `block_id`，便于定点修改） |
| `table <doc>` | 把文档内的表格按行列还原导出 |
| `create --title X [--folder T]` | 创建文档 |
| `append <doc> --md <markdown\|@file>` | 追加 Markdown（本地转换，支持标题/列表/引用/代码/分隔线/链接/加粗） |
| `update-block <doc> <block_id> --text X` | 修改指定块 |
| `delete-block` / `delete <doc>` | 删除块 / 删除文档 |
| `list` / `search <关键词>` | 列出云空间文件 / 搜索文档 |
| `wiki-search <关键词>` | 搜索知识库节点（知识库文档只能用它搜到） |
| `wiki-add <doc> --space <space_id>` | 把云文档加入知识库 |
| `share <doc> --member X [--perm view\|edit]` | 添加协作者 |

辅助脚本：

- `inventory.mjs`：扫描云空间 + 知识库，输出清单与统计
- `wiki-inventory.mjs`：枚举全部知识库空间与节点
- `reorganize.mjs`：按主题建分类父页面并批量移动文档（`--apply` 才执行）
- `login.mjs`：用户身份 OAuth 登录（`--url` 打印授权链接，或用授权码换取令牌）

## 身份与凭据

- 应用凭据读取自 acp-claw 的 `config.json`（`feishu.appId` / `feishu.appSecret`）
- **用户身份**：令牌保存在**仓库之外**的 `~/.acp-claw/feishu-doc-data/user-token.json`
  （可用 `FEISHU_DATA_DIR` 覆盖；access token 2 小时自动刷新，refresh token 30 天）
- 默认策略：有用户令牌就用用户身份，否则用应用身份；`FEISHU_TOKEN_MODE=tenant|user` 可强制

> ⚠️ 令牌与扫描数据一律不要放进仓库；`.gitignore` 已忽略 `tools/feishu-doc/data/`。

## 前置权限

飞书开放平台里，应用需要开通对应权限（应用身份与用户身份分别配置）：

- `docx:document`（创建 / 编辑文档）、`drive:drive`（文件列表、协作者）
- 知识库相关：`wiki:wiki`；表格 / 多维表格另需 `sheets:spreadsheet` / `bitable:app`
- 用户身份还需要 `offline_access`，并在「安全设置 → 重定向 URL」登记回调地址

应用身份只能操作**自己创建的**或**共享给该应用**的文档；用户身份可访问该用户可见的文档。

## 示例

```bash
# 读取（支持 wiki 链接）
node cli.mjs read "https://example.feishu.cn/wiki/xxxxxxxx"

# 往文档追加一段 Markdown
node cli.mjs append <doc_id> --md $'# 标题\n\n- 第一条\n- 第二条'

# 搜索知识库
node cli.mjs wiki-search 推理

# 把新文档放进指定知识库
node cli.mjs create --title "索引" | tee /tmp/new.json
node cli.mjs wiki-add <doc_id> --space <space_id>
```

## 注意

- 调用飞书 API 需要联网；在受限沙箱里执行时需提权（sandbox escalation）
- 单次插入块数有上限（约 50），`append` 已自动分批
- 更新块统一使用 `update_text_elements`（飞书对标题/列表也接受该字段）
