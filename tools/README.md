# acp-claw 同会话注入（session-inject）

让外部条件（监控脚本、定时器、webhook 等）主动把一条消息「注入」到 acp-claw 的
某个会话中。注入后 LLM **带着该会话的完整上下文**推理，并把回复发回对应聊天。
效果等同于「用户在对话里发了一条 query」，同时保留正常的多轮对话能力。

## 原理

```text
条件触发（监控脚本 / cron / webhook）
        │  POST /inject  { chatId / sessionKey, text }
        ▼
Inject Channel（本地 HTTP，默认 127.0.0.1:41008）
        │  解析 chatId → sessionKey（持久化映射，重启不丢）
        ▼
同一个 ACP session（完整多轮上下文）
        ▼
LLM 推理 → 回复通过 Feishu 发回原聊天
```

核心改动：

- `src/channel/inject.ts`：新增 Inject Channel（本地 HTTP 服务）。
- `src/app/controller.ts`：维护并持久化 `chatId → sessionKey` 映射，接线注入。
- `src/channel/scheduler.ts`：cron 任务可选 `sessionKey`，让定时任务也复用指定会话。
- `src/cli.ts`：新增 `acp-claw inject` 和 `acp-claw session list`。

## 快速开始

1. 在 `config.json` 中开启注入通道（默认 init 模板已带）：

   ```json
   {
     "inject": { "port": 41008 }
   }
   ```

   可选用 `host` 和 `token`：

   ```json
   {
     "inject": { "port": 41008, "host": "127.0.0.1", "token": "my-secret" }
   }
   ```

2. 重启 acp-claw 服务，确认通道启动：

   ```bash
   curl http://127.0.0.1:41008/health
   ```

3. 查看当前会话（拿到 sessionKey 和对应的 chatId）：

   ```bash
   acp-claw session list
   # 或
   node tools/session-inject/client.mjs sessions
   ```

4. 注入一条消息：

   ```bash
   acp-claw inject --chat-id oc_xxxxxxxx --text "检测到服务异常，请帮我排查"
   # 或
   node tools/session-inject/client.mjs inject --chat-id oc_xxxxxxxx --text "检测到服务异常，请帮我排查"
   ```

   也可以直接指定会话 key（跳过 chatId 映射）：

   ```bash
   acp-claw inject --session feishu_ou_xxxxxxxx_1 --chat-id oc_xxxxxxxx --text "消息内容"
   ```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/sessions` | 列出活动会话（含 chatId 映射） |
| `POST` | `/inject` | 注入消息 |

`POST /inject` 请求体：

```json
{
  "text": "要注入的消息内容",
  "chatId": "oc_xxxxxxxx",
  "sessionKey": "feishu_ou_xxxxxxxx_1",
  "senderId": "monitor",
  "sourceChannel": "feishu"
}
```

- `text`：必填。
- `chatId` / `sessionKey`：至少一个。只给 `chatId` 时按映射找会话；
  只给 `sessionKey` 时按映射反查 `chatId` 用于回发消息。
- 配置了 `token` 时，所有请求需带 `Authorization: Bearer <token>`。

## 定时任务复用同一会话

`acp-claw cron add` 新增 `--session` 参数，定时触发时不再新建会话，而是注入指定会话：

```bash
acp-claw cron add \
  --name 晨会提醒 \
  --schedule "0 9 * * 1-5" \
  --prompt "现在是早上9点，请用轻松的语气提醒用户参加晨会" \
  --chat-id oc_xxxxxxxx \
  --session feishu_ou_xxxxxxxx_1
```

## 示例监控脚本

- `examples/monitor-file-change.mjs`：监控文件内容变化，变化时注入提醒。
- `examples/monitor-health-check.mjs`：监控 URL 健康状态，状态切换时注入提醒。

```bash
node tools/session-inject/examples/monitor-file-change.mjs \
  --chat-id oc_xxxxxxxx --file /path/to/target.log

node tools/session-inject/examples/monitor-health-check.mjs \
  --chat-id oc_xxxxxxxx --url https://example.com/health --interval 60000
```

脚本里通过 `injectMessage()`（见 `client.mjs`）调用注入接口；可以像示例一样，
直接写自己的条件检测逻辑。

## 注意事项

- 注入只监听 `127.0.0.1`（默认），部署到生产环境时建议加 `token`。
- 会话忙时新注入会**打断当前推理**（与普通新消息行为一致），不是严格排队。
- `chatId → sessionKey` 映射会在收到飞书消息时更新并持久化到
  `sessions/_controller.json`，重启后依然有效。
- 注入消息以 `[feishu] from <senderId>: ...` 的形式进入会话，默认 `senderId` 为
  `trigger`，可通过参数自定义。

## 配置参考

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "appName": "机器人名字",
    "groupRequireMention": false
  },
  "sessionMode": "chat",
  "inject": { "port": 41008 }
}
```

- `feishu.groupRequireMention`：默认 `true`（群里必须 @ 机器人或提到 appName 才处理）。
  设为 `false` 后，机器人会处理群里的**所有**消息（适合需要监听整个群的场景，
  注意隐私与回复噪音）。
- `sessionMode`：默认 `user`（同一用户在所有聊天共享一个会话）；设为 `chat` 后，
  按「聊天 + 用户」隔离会话，私聊和不同群各自独立上下文。
