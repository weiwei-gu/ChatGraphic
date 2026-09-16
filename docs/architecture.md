# 架构与设计要点

对齐产品描述 v0.3 的「Hook 驱动、同链路同边界」。

## 数据流

```
你在本项目里与 Codely 对话
   │  每轮结束（AfterAgent Hook，由 install.js 注册于 ~/.codely-cli/settings.json）
   ▼
chatgraphic/hook.js            ← 毫秒级退出不阻塞对话；转录去重；本会话旧解析最新胜出
   │  异步派发（detached）
   ▼
chatgraphic/parser.js          ← 转录精简 → spawn codely -p（同一模型链路/认证，独占临时目录）
   ▼
work/sessions/<会话id>/graph.json   ← 分型 + 三问准入 + 置信分级 → 版本递增
   │  serve.js（本地只读服务，2s 轮询）
   ▼
浏览器 viewer                  ← 导图实时生长 / 会话列表切换 / 节点回链对话原文 / 导出 PNG、Markdown
```

## 组件职责

| 组件 | 职责 |
|---|---|
| `hook.js` | AfterAgent 触发器：防递归 / sha1 去重 / 取代未完成旧解析，会话级隔离 |
| `parser.js` | 解析 worker：转录归一化（auto-save JSON / 数组 / 实时 JSONL 容错）→ 精简 → 同链路解析 → graph.json |
| `parse-prompt.md` | 解析提示词：分型 + 三问准入 + 置信分级 + 严格 JSON schema + 上一版 id 稳定性 |
| `serve.js` | 零依赖本地服务（端口占用自动避让），多会话路由 |
| `viewer.html` | 只读导图：分层布局、生长动画、多会话切换、节点回链、导出 PNG/Markdown |
| `install.js` | 用户级 AfterAgent Hook 注册 / 移除（写入 `~/.codely-cli/settings.json`） |

## 设计要点

- **轮次级实时**：AfterAgent（每轮 Agent 结束）触发全量重解析——MVP 简单可靠，秒级增量是 Phase 2
- **同链路同边界**：解析即 `codely -p`，与对话同一模型、同一认证、同一数据边界；渲染、存储、导出全程本地
- **三问准入 / 置信分级**：内容须是可执行任务 / 可复用决策 / 可追溯变更才上图；低置信进「待确认」
- **证据优先**：任务状态由文件变更、命令执行等真实证据驱动，语义推断会标注来源
- **多窗口 / 多项目共存**：每会话独立 `work/sessions/<id>/`，serve 端口自动避让
- **一键关闭**：`chatgraphic/config.json` 中 `enabled: false`，Hook 立即静默跳过

## 状态与路线

POC 已端到端验证：真实会话 → Hook 自动触发 → 同链路解析出图；多窗口并行隔离；导出 PNG/Markdown。
Phase 2+（见产品描述 v0.3）：秒级增量解析（滚动窗口 + 图状态摘要）、节点编辑、版本快照回退、多会话合并、团队分享。
