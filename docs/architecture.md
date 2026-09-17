# 架构与设计要点

对齐产品描述 v0.3 的「Hook 驱动、同链路同边界」。

## 数据流

```
Codely 对话 ──────── 每轮结束 AfterAgent Hook（install.js 注册）
Codex 对话 ──────── 每轮结束 agent-turn-complete（install-codex.js 写入 config.toml notify）
Claude 对话 ─────── 每轮响应结束 Stop 事件（install-claude.js 写入 settings.json hooks.Stop）
   │
   ▼
hook.js / codex-hook.js / claude-hook.js   ← 毫秒级退出不阻塞对话；转录去重；本会话旧解析最新胜出（会话级隔离）
   │  异步派发（detached）
   ▼
chatgraphic/parser.js          ← 转录归一化（三端格式容错）→ 精简 → 引擎路由同链路解析：
                                 Codely → codely -p ／ Codex → codex exec ／ Claude → claude -p
                                 （各走各的模型/认证，独占临时目录；CHATGRAPHIC_CHILD 防递归）
   ▼
work/sessions/<会话id>/graph.json   ← 分型 + 三问准入 + 置信分级 → 版本递增
   │  serve.js（本地只读服务，2s 轮询）
   ▼
浏览器 viewer                  ← 导图实时生长 / 三端会话混排切换 / 节点回链对话原文 / 导出 PNG、Markdown
```

> v0.2.0 起：同会话增量解析——解析输入 = 当前图状态摘要 + 新增轮次（不再重发全量转录），全量仅作首次与兜底。
> 三端注册作用域对比（Codex 项目级 notify 实测不生效等结论）见 [guide.md](guide.md)。

## 组件职责

| 组件 | 职责 |
|---|---|
| `hook.js` | Codely AfterAgent 触发器：防递归 / sha1 去重 / 取代未完成旧解析，会话级隔离 |
| `codex-hook.js` | Codex notify 触发器：按 thread-id 定位 rollout；同款秒退/去重/取代旧解析 |
| `claude-hook.js` | Claude Stop 触发器：stdin JSON 自带 transcript_path；同款秒退/去重/取代旧解析 |
| `parser.js` | 解析 worker：转录归一化（auto-save JSON / 数组 / 实时 JSONL / Codex rollout / Claude 转录 容错）→ 精简 → 引擎路由同链路解析 → graph.json |
| `parse-prompt.md` | 解析提示词：分型 + 三问准入 + 置信分级 + 严格 JSON schema + 上一版 id 稳定性 |
| `serve.js` | 零依赖本地服务（端口占用自动避让），多会话路由 |
| `viewer.html` | 只读导图：分层布局、生长动画、多会话切换、节点回链、导出 PNG/Markdown |
| `install.js` | Codely Hook 注册 / 移除（作用域跟随安装位置：workspace → 项目级 `$CODELY_PROJECT_DIR` 锚定；用户级 → `~/.codely-cli/settings.json`） |
| `install-codex.js` | Codex notify 注册 / 移除（`~/.codex/config.toml` 顶层键插到首个表头前；他人占用不覆盖） |
| `install-claude.js` | Claude Stop Hook 注册 / 移除（`~/.claude/settings.json` hooks 数组并存追加） |

## 设计要点

- **轮次级实时**：AfterAgent（每轮 Agent 结束）触发；v0.2.0 起**增量解析**（滚动窗口 + 图状态摘要）——同会话第二次起输入仅为图状态 + 新增轮次，实测输入缩小约两个数量级、耗时约 1/4，成本近似常数；首次 / 转录压缩 / 增量失败或疑似丢节点（移除过半上一版节点）自动回退全量，`--full` 可强制全量
- **同链路同边界**：解析引擎按转录来源路由——Codely 会话 `codely -p`、Codex 会话 `codex exec`、Claude 会话 `claude -p`，各与对话同一模型、同一认证、同一数据边界（纯 Codex / Claude 用户零 codely 依赖）；渲染、存储、导出全程本地
- **三问准入 / 置信分级**：内容须是可执行任务 / 可复用决策 / 可追溯变更才上图；低置信进「待确认」
- **证据优先**：任务状态由文件变更、命令执行等真实证据驱动，语义推断会标注来源
- **多窗口 / 多项目共存**：每会话独立 `work/sessions/<id>/`，serve 端口自动避让
- **一键关闭**：`chatgraphic/config.json` 中 `enabled: false`，Hook 立即静默跳过

## 状态与路线

POC 已端到端验证：三端真实会话（Codely AfterAgent / Codex notify / Claude Stop）各自触发、各自引擎解析出图；多窗口并行隔离；导出 PNG/Markdown。
Phase 2+（见产品描述 v0.3）：秒级增量解析（滚动窗口 + 图状态摘要）、节点编辑、版本快照回退、多会话合并、团队分享。
