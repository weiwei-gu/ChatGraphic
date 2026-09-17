# ChatGraphic

> 和 AI 对话的同时，看着导图实时生长 —— 支持 Codely / Codex CLI / Claude Code 三端的会话导图

ChatGraphic 是 AI 编程 CLI 的配套可视化工具（当前接入 [Codely](https://codely-docs.tuanjie.cn)、Codex CLI、Claude Code）：**对话进行中**即实时解析——方案、最终选择、任务、决策、文件变更自动长成一张导图，聊完即得图。讨论不迷路，成果可沉淀。三端各自 Hook 触发、各走各的模型链路解析，数据统一本地存储、同一个 viewer 混排查看。

- 在线产品页：<https://weiwei-gu.github.io/ChatGraphic/>（产品介绍页）
- 快速开始：

```bash
codely extensions install https://github.com/weiwei-gu/ChatGraphic --scope workspace
node .codely-cli/extensions/chatgraphic/chatgraphic/install.js     # 注册 Hook（作用域跟随安装：此处为项目级）
```

`--scope workspace` 把扩展装入**本项目的** `.codely-cli/extensions/`（从最新 Release 拉取）；不加则装入用户目录 `~/.codely-cli/extensions/`（全局共享一份）。查看导图：`node .codely-cli/extensions/chatgraphic/chatgraphic/serve.js`。

**Codex CLI / Claude Code 用户**（克隆仓库后）：

```bash
node chatgraphic/install-codex.js    # Codex：写入 ~/.codex/config.toml 的 notify
node chatgraphic/install-claude.js   # Claude Code：写入 ~/.claude/settings.json 的 hooks.Stop
```

三端接入与卸载细节见 **[docs/guide.md](docs/guide.md)**。注册作用域：Codely 跟随扩展安装位置（`--scope workspace` 即项目级）；Codex / Claude 当前为用户级全局注册（Codex 实测项目级 notify 不生效；Claude 原生支持项目级 hooks，安装器暂未提供）——对比表见 guide。

安装与使用细节（信任机制、数据目录、成本控制）见 **[docs/guide.md](docs/guide.md)**。

## 目录介绍

```
├── ChatGraphic产品描述 v0.3.html   产品描述文档（最新版，本项目的需求源头）
├── gemini-extension.json          Codely 扩展 manifest（extensions install 入口）
├── package.json / scripts/        测试与发布脚本（npm test / 版本一致性校验）
├── .github/workflows/             CI（测试矩阵）与 Release（tag → GitHub Release）
├── chatgraphic/                   POC 实现（组件细节见 chatgraphic/README.md）
│   ├── hook.js                    AfterAgent 触发器：去重 / 取代旧解析 / 秒级退出
│   ├── parser.js                  解析 worker：精简 → 同链路解析（按转录来源路由：Claude→claude -p / Codex→codex exec / 其余→codely -p）→ graph.json（自动增量：图状态+新增轮次）
│   ├── parse-prompt.md            解析提示词：分型 + 三问准入 + 置信分级
│   ├── serve.js / viewer.html     本地只读视图服务与导图界面（生长动画 / 回链原文 / 导出）
│   ├── install.js                 用户级 Hook 注册 / 移除
│   ├── codex-hook.js              Codex notify 触发器（agent-turn-complete → 同链路解析）
│   ├── install-codex.js           Codex notify 注册 / 移除（写入 ~/.codex/config.toml）
│   ├── claude-hook.js              Claude Code Stop Hook 触发器（stdin JSON → 同链路解析）
│   ├── install-claude.js           Claude Stop Hook 注册 / 移除（写入 ~/.claude/settings.json）
│   ├── config.json                开关 / 解析模型 / 端口 / 截断上限
│   └── test/                      58 个离线测试用例（node --test，零依赖）
└── docs/                          产品页发布副本（index.html = GitHub Pages）+ 详细文档
    ├── guide.md                   安装与使用指南
    ├── architecture.md            架构、组件职责与设计要点
    └── development.md             开发、测试与发布流程
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/guide.md](docs/guide.md) | 扩展 / 克隆两种安装方式、信任机制、日常使用与复盘 |
| [docs/architecture.md](docs/architecture.md) | 数据流架构、组件职责、设计要点（三问准入 / 同链路同边界）、路线 |
| [docs/development.md](docs/development.md) | 测试、CI/CD、发版流程、GitHub Pages 静态发布 |
| [chatgraphic/README.md](chatgraphic/README.md) | POC 组件细节、成本与控制、故障排查 |
