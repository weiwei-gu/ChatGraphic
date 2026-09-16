# ChatGraphic

> 和 AI 对话的同时，看着导图实时生长 —— 基于 Codely 的会话导图

ChatGraphic 是 [Codely](https://codely-docs.tuanjie.cn)（AI 编程 CLI）的配套可视化工具：**对话进行中**即实时解析——方案、最终选择、任务、决策、文件变更自动长成一张导图，聊完即得图。讨论不迷路，成果可沉淀。

本仓库包含：产品描述文档（`ChatGraphic产品描述 v0.3.html`）与**可运行的 POC**（`chatgraphic/`）——真实 Hook 触发、真实同链路解析、本地渲染，非脚本演示。

## 快速开始（POC）

前置：本机已安装并登录 `codely` CLI（POC 通过 `codely -p` 复用同一模型链路）。

```bash
git clone git@github.com:weiwei-gu/ChatGraphic.git
cd ChatGraphic

node chatgraphic/serve.js     # 启动导图视图（自动打开 http://localhost:4830）

# 在本仓库目录里启动 Codely 正常对话；首次需信任项目 Hook：/hooks trust-project
# 之后每轮结束，导图自动生长（实测单轮出图约 8~15 秒，不阻塞对话）
```

历史会话复盘：`node chatgraphic/parser.js --transcript <会话JSON路径>`

## 架构（对齐产品描述 v0.3「Hook 驱动、同链路同边界」）

```
你在本项目里与 Codely 对话
   │  每轮结束（AfterAgent Hook，配置于 .codely-cli/settings.json）
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

| 组件 | 职责 |
|---|---|
| `hook.js` | AfterAgent 触发器：防递归 / sha1 去重 / 取代未完成旧解析，会话级隔离 |
| `parser.js` | 解析 worker：转录归一化（auto-save JSON / 数组 / 实时 JSONL 容错）→ 精简 → 同链路解析 → graph.json |
| `parse-prompt.md` | 解析提示词：分型 + 三问准入 + 置信分级 + 严格 JSON schema + 上一版 id 稳定性 |
| `serve.js` | 零依赖本地服务（端口占用自动避让），多会话路由 |
| `viewer.html` | 只读导图：分层布局、生长动画、多会话切换、节点回链、导出 PNG/Markdown |
| `.codely-cli/settings.json` | 项目级 AfterAgent Hook 配置（首次使用需信任） |

## 设计要点

- **轮次级实时**：AfterAgent（每轮 Agent 结束）触发全量重解析——MVP 简单可靠，秒级增量是 Phase 2
- **同链路同边界**：解析即 `codely -p`，与对话同一模型、同一认证、同一数据边界；渲染、存储、导出全程本地
- **三问准入 / 置信分级**：内容须是可执行任务 / 可复用决策 / 可追溯变更才上图；低置信进「待确认」
- **证据优先**：任务状态由文件变更、命令执行等真实证据驱动，语义推断会标注来源
- **多窗口 / 多项目共存**：每会话独立 `work/sessions/<id>/`，serve 端口自动避让
- **一键关闭**：`chatgraphic/config.json` 中 `enabled: false`，Hook 立即静默跳过

## 仓库结构

```
├── ChatGraphic产品描述 v0.3.html             # 产品描述文档（最新版）
├── chatgraphic/                             # POC 实现（详见 chatgraphic/README.md）
│   ├── hook.js · parser.js · parse-prompt.md · serve.js · viewer.html · config.json
├── docs/index.html                           # 产品描述 v0.3 副本（GitHub Pages 发布目录）
└── .codely-cli/settings.json                # AfterAgent Hook 配置
```

> 静态发布：GitHub Settings → Pages → Branch `main` / Folder `/docs`，发布后访问 `https://weiwei-gu.github.io/ChatGraphic/`。更新文档后重新 `cp "ChatGraphic产品描述 v0.3.html" docs/index.html` 即可。

## 状态与路线

POC 已端到端验证：真实会话 → Hook 自动触发 → 同链路解析出图；多窗口并行隔离；导出 PNG/Markdown。
Phase 2+（见产品描述 v0.3）：秒级增量解析（滚动窗口 + 图状态摘要）、节点编辑、版本快照回退、多会话合并、团队分享。
