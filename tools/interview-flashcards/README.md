# 面经记忆卡组

基于 MIT 项目 [ByeByeBaGu](https://github.com/Nina-noSchool/ByeByeBaGu) 的静态学习站点。
本项目不重写前端，只负责：

1. 从 `~/.acp-claw/daily-report/interview-bank.json` 读取面经题点；
2. 修复题目、生成短答/要点/追问/易错点，并按语义去重；
3. 生成大模型/Agent、具身智能、AI Infra 三个 Markdown 卡组；
4. 将 ByeByeBaGu 与卡组发布到 `acp-claw` 仓库的 `gh-pages` 分支 `/memory/`。

发布时会注入一个很小的首屏引导：新浏览器首次打开时，自动调用 ByeByeBaGu 自带解析器导入卡组；
已有学习进度不会重置。卡组版本变化时会只补新卡，按语义去重。

## 命令

```bash
CLI=/home_ext/quyanyi/acp-claw/tools/interview-flashcards

node $CLI/generate.mjs
node $CLI/deploy.mjs
```

生成缓存位于 `~/.acp-claw/daily-report/interview-cards.json`。已有题目不会重复调用模型；
新增面经只补新卡。

## 本地目录

- ByeByeBaGu 上游：`~/career-memory/ByeByeBaGu`
- 生成的卡组：`~/career-memory/decks`
- 公网入口：https://afarfabula.github.io/acp-claw/memory/

## License

ByeByeBaGu 前端保留上游 MIT License 与第三方声明。生成的题目和答案仅用于个人学习，
投递或引用前请回看原帖并在面试前自行复核技术表述。
