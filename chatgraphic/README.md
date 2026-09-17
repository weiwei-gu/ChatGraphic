# ChatGraphic POC — 三端（Codely / Codex CLI / Claude Code）会话导图

> 把「与 AI 编程 CLI 的对话」实时解析成一张会话导图：**方案 → 最终选择 → 任务 → 决策 → 文件变更**，边聊边长，聊完即得图。
> 本目录是产品描述 v0.3 的可运行 POC：**真实 Hook 触发、真实同链路解析、本地渲染**，非脚本演示。

## 架构（对齐 v0.3「Hook 驱动、同链路同边界」）

```
Codely 对话 ── 每轮结束 AfterAgent Hook（install.js，作用域跟随安装位置）
Codex 对话 ── 每轮结束 notify agent-turn-complete（install-codex.js → ~/.codex/config.toml）
Claude 对话 ─ 每轮响应结束 Stop 事件（install-claude.js → ~/.claude/settings.json）
   ▼
hook.js / codex-hook.js / claude-hook.js   ← 秒退不阻塞对话；sha1 去重；杀掉未完成的旧解析（最新胜出，会话级隔离）
   │  异步派发（detached）
   ▼
chatgraphic/parser.js          ← 转录归一化（三端格式容错）→ 精简 → 引擎路由同链路解析：
                                 Codely → codely -p ／ Codex → codex exec ／ Claude → claude -p（各走各的模型/认证）
   ▼
graph.json（用户级扩展 → ~/.chatgraphic/；项目级扩展 → <项目>/.chatgraphic/；克隆 → 本目录 work/）  ← 分型 + 三问准入 + 置信分级 → 版本递增（每会话独立目录）
   │  serve.js（本地只读服务，2s 轮询）
   ▼
浏览器 viewer                  ← 导图实时生长 / 三端会话混排切换 / 节点回链对话原文 / 导出 PNG、Markdown
```

## 多窗口 / 多项目同机共存

| 场景 | 行为 |
|---|---|
| 同项目多个 Codely 窗口 | 每个会话独立目录 `work/sessions/<会话id>/`（独立去重、独立解析进程、独立导图），互不干扰、互不残杀；viewer 默认跟随最新会话，左栏「会话」面板可点击固定查看任意会话，固定后点「● 跟随最新会话」切回 |
| 多项目（如本目录与 `test/`） | 各项目独立部署 `chatgraphic/`，数据完全隔离；serve 端口被占用时**自动 +1 避让**并打印实际地址 |
| 并行解析 | 每次解析使用 mkdtemp 独占临时目录，同机并行无共享状态 |

## 快速开始

前置：已通过 `node chatgraphic/install.js` 注册 Hook（作用域跟随安装/克隆位置，未注册先执行，详见根 README）；Codex / Claude Code 接入见下文两节。直接两步：

```bash
# 1. 启动导图视图（会自动打开浏览器；或手动访问 http://localhost:4830）
node chatgraphic/serve.js

# 2. 在本项目里正常使用 Codely 聊天 —— 每轮结束后数秒~一两分钟内，导图自动生长
```

> 每个项目首次使用时需信任一次：在该项目的 Codely 会话里执行 `/hooks trust-project`（CLI 安全机制，信任指纹按项目记录）。

## Codex CLI 支持（实验）

ChatGraphic 也能长出 **Codex CLI** 会话的导图：Codex 的 `notify` 机制在每轮结束（`agent-turn-complete`）时以 JSON（最后一个参数）调用外部程序，借此触发同一套解析链路。

```bash
# 注册（幂等写入 ~/.codex/config.toml 的 notify 键；--uninstall 移除 / --status 查看）
node chatgraphic/install-codex.js

# 之后正常使用 Codex —— 每轮结束自动解析出图；历史会话可手动补跑：
node chatgraphic/codex-hook.js ~/.codex/sessions/2026/09/06/rollout-xxxx-<thread-id>.jsonl
```

- **链路**：notify → `codex-hook.js`（按 `thread-id` 定位 `sessions/<年/月/日>/rollout-*-<thread-id>.jsonl` 全量转录）→ 同一套 `parser.js` → **引擎路由（同链路）**：Codex 会话用 `codex exec` 解析（你 Codex 配置的模型/认证，`config.json` 的 `model` 不参与）；Codely 会话仍走 `codely -p` → 同一个 viewer
- **转录适配**：parser 自动识别 Codex rollout 格式（跳过 developer/环境注入与 event_msg 回显；工具名经 call_id 映射）；会话 id = thread-id
- **注意**：`config.toml` 的 `notify` 已被其他程序占用时不覆盖（告警提示手动处理）；注册作用域仅用户级（Codex 项目级 config 中 notify 实测不触发，见 docs/guide.md 对比表）；数据目录按注册脚本位置判定（见下文架构图注）；`config.json` 的 `"enabled": false` 同样一键关闭**全部三端**；Codex 新版 hooks 系统（0.145+）只拦截工具调用、无轮次结束事件，故选 notify 通道

## Claude Code 支持（实验）

ChatGraphic 也能长出 **Claude Code** 会话的导图：每轮响应结束（Stop 事件）时，Claude Code 以 JSON 经 stdin 调用 Hook 命令，借此触发同一套解析链路。

```bash
# 注册（幂等写入 ~/.claude/settings.json 的 hooks.Stop；--uninstall 移除 / --status 查看）
node chatgraphic/install-claude.js

# 之后正常使用 Claude Code —— 每轮结束自动解析出图；历史会话可手动补跑：
node chatgraphic/claude-hook.js ~/.claude/projects/<项目slug>/<会话id>.jsonl
```

- **链路**：Stop Hook → `claude-hook.js`（stdin payload 自带 transcript_path，缺失时回退搜索 projects 树；SubagentStop 等其他事件一律忽略）→ 同一套 `parser.js` → **引擎路由（同链路）**：Claude 会话用 `claude -p` 解析（你 Claude Code 配置的模型/认证）→ 同一个 viewer
- **转录适配**：parser 自动识别 Claude 转录格式（跳过 isMeta / isSidechain 子代理旁路与 mode/attachment 等噪音行；`<command-name>`/`<system-reminder>` 等注入不构成轮次；工具名经 tool_use_id 映射）；会话 id = session_id
- **注意**：Claude 的 hooks 是数组结构——与他人既有 Stop Hook 并存追加互不影响（区别于 Codex notify 的单槽互斥）；`config.json` 的 `"enabled": false` 一键关闭全部触发端

## 手动补跑历史会话（复盘场景）

三种转录格式自动识别，任选一种入口：

```bash
node chatgraphic/parser.js --transcript .codely-cli/auto-saves/chat-auto-save-xxxx.json   # Codely auto-save
node chatgraphic/codex-hook.js ~/.codex/sessions/<年/月/日>/rollout-xxxx-<thread-id>.jsonl # Codex rollout
node chatgraphic/claude-hook.js ~/.claude/projects/<项目slug>/<会话id>.jsonl               # Claude 转录
```

补跑结果会覆盖当前导图（全量重解析语义），版本号递增；加 `--full` 可强制全量（parser.js 入口）。

## 成本与控制

| 事项 | 说明 |
|---|---|
| 解析成本 | **自动增量（v0.2.0）**：同会话第二次起仅发送「图状态摘要 + 新增轮次」，实测输入从 38K 降到 0.4K 字符、耗时约 1/4，成本近似常数不再随会话线性涨；首次 / 转录被压缩 / 增量失败或疑似丢节点 → 自动回退全量；模型默认 `codely-flash` |
| 转录上限 | 单轮文本截断 `maxTurnChars`；总载荷上限 `maxTotalLeanChars`，超限保头保尾略去中段（解析器会在「待确认」里如实标注） |
| 一键关闭 | `chatgraphic/config.json` 里 `"enabled": false`（三端 Hook 立即静默跳过）；彻底移除则按端执行 `node chatgraphic/install.js --uninstall` / `install-codex.js --uninstall` / `install-claude.js --uninstall` |
| 换模型 | Codely 引擎：`config.json` 的 `"model"` 改为任意已配置模型 id（如 `codely-core` 更强但更慢更贵）；Codex 引擎：用你 `~/.codex/config.toml` 配置的模型；Claude 引擎：用你 `~/.claude/settings.json` 配置的模型（后两者的 `config.json` 的 `model` 均不参与） |
| 解析超时 | `parseTimeoutMs` 默认 240 秒/次（失败自动重试一次）。Claude/Codex 引擎走各自代理时大载荷可能偏慢：超长会话（转录 >1MB）可在 `config.json` 调大该值（如 600000） |
| 观测 | `chatgraphic/work/hook.log`（全链路日志）、`status.json`（当前解析状态）、`version.txt`（导图版本） |

## 故障排查

1. **导图不更新** → 看 `work/hook.log`：
   - 无任何记录：Hook 没触发，运行 `/hooks` 检查是否 `enabled ... [user]`；未信任则在该项目执行 `/hooks trust-project`；未注册则运行 `node chatgraphic/install.js --status` 查看
   - `hook: 已派发解析` 后 `parser: 失败`：按日志里的错误处理（常见为解析超时，可调大 `parseTimeoutMs`）
2. **解析结果质量波动** → 属于 LLM 正常现象，下一轮全量重解析会自愈；`parse-prompt.md` 可继续收紧
3. **viewer 打不开** → 确认 `node chatgraphic/serve.js` 在跑、端口未被占用（`--port` 可换）
4. **想清空重来** → 删除 `chatgraphic/work/sessions/` 下对应会话目录（或整个 `work/`）

## 文件一览

| 文件 | 职责 |
|---|---|
| `~/.codely-cli/settings.json` 或 `<项目>/.codely-cli/settings.json` | 由 `chatgraphic/install.js` 注册的 AfterAgent Hook（作用域跟随安装位置：用户级全局生效 / workspace 项目级，均按项目信任） |
| `chatgraphic/hook.js` | 触发器：防递归 / 去重 / 取代旧解析 / 异步派发，毫秒级退出 |
| `chatgraphic/parser.js` | 解析 worker：转录归一化（auto-save JSON / 数组 / 实时 JSONL / Codex rollout / Claude 转录 容错）→ 精简 → 同链路解析（引擎路由：Claude 会话 `claude -p`、Codex 会话 `codex exec`、其余 `codely -p`）→ graph.json；v0.2.0 起支持增量解析（滚动窗口 + 图状态摘要，全量兜底） |
| `chatgraphic/parse-prompt.md` | 解析提示词：分型 + 三问准入 + 置信分级 + 严格 JSON schema + 上一版 id 稳定性 |
| `chatgraphic/serve.js` | 零依赖本地服务：viewer / graph.json / transcript.json / version / status |
| `chatgraphic/install.js` | Codely Hook 注册/移除（`--uninstall` / `--status`），作用域跟随安装位置，扩展安装方式配套 |
| `chatgraphic/codex-hook.js` | Codex notify 触发器：`agent-turn-complete` → 按 thread-id 定位 rollout → 同款秒退/去重/取代旧解析/派发 |
| `chatgraphic/install-codex.js` | Codex notify 注册/移除（写入 `~/.codex/config.toml`，顶层键插到首个表头前、幂等、他人占用不覆盖） |
| `chatgraphic/claude-hook.js` | Claude Code Stop Hook 触发器：stdin JSON（transcript_path + session_id）→ 同款秒退/去重/取代旧解析/派发 |
| `chatgraphic/install-claude.js` | Claude Stop Hook 注册/移除（写入 `~/.claude/settings.json`，数组并存追加、幂等、他人条目保留） |
| `chatgraphic/viewer.html` | 只读导图：分层布局、生长动画、节点回链原文、拖拽缩放、导出 PNG/Markdown；`?embed=1` 内嵌模式（侧栏抽屉化，供 TerminalServer 等宿主窄面板嵌入，独立使用不受影响） |
| `chatgraphic/test/` | 58 个离线测试用例（`npm test`，node --test；不调用 codely/codex/claude） |
| `chatgraphic/work/` | 运行时产物：`sessions/<会话id>/`（graph.json / transcript.json / status.json …）、`current.json`（最新会话指针）、`hook.log`（全链路日志） |

## 与 v0.3 的对齐与边界

- ✅ **轮次级实时**：三端各自轮次结束事件触发（Codely AfterAgent / Codex notify / Claude Stop），Hook 不阻塞对话
- ✅ **同链路同边界**：解析引擎按转录来源路由（`codely -p` / `codex exec` / `claude -p`），与对话同一模型/认证/数据边界，运行在 tmpdir 不加载项目配置；渲染、存储、导出全程本地
- ✅ **三问准入 / 置信分级**：不可执行、非决策、非变更的内容不上图；低置信进「待确认」
- ✅ **证据优先**：任务状态由文件变更/命令执行等真实证据驱动
- ✅ **降级与止损**：`enabled:false` 一键关三端；解析失败保留上一版导图；历史会话可手动补跑
- ⛔ POC 范围外（v0.3 Phase 2+）：节点编辑、版本快照回滚、多会话合并、分享
