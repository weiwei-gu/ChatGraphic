# ChatGraphic POC — 基于 Codely 的会话导图

> 把「与 Codely 的对话」实时解析成一张会话导图：**方案 → 最终选择 → 任务 → 决策 → 文件变更**，边聊边长，聊完即得图。
> 本目录是产品描述 v0.3 的可运行 POC：**真实 Hook 触发、真实同链路解析、本地渲染**，非脚本演示。

## 架构（对齐 v0.3「Hook 驱动、同链路同边界」）

```
你在本项目里与 Codely 对话
   │  每轮结束（AfterAgent Hook，由 install.js 注册于 ~/.codely-cli/settings.json）
   ▼
chatgraphic/hook.js            ← 秒退不阻塞对话；sha1 去重；杀掉未完成的旧解析（最新胜出）
   │  异步派发（detached）
   ▼
chatgraphic/parser.js          ← 转录精简（剥离上下文噪音/工具结果截断）
   │  spawn: codely -p（同一模型链路/认证，跑在 tmpdir，不加载项目配置）
   ▼
chatgraphic/work/sessions/<会话id>/graph.json   ← 分型 + 三问准入 + 置信分级 → 版本递增（每会话独立目录）
   │  serve.js（本地只读服务，2s 轮询）
   ▼
浏览器 viewer                  ← 导图实时生长 / 会话列表切换 / 节点回链原文 / 导出 PNG、Markdown
```

## 多窗口 / 多项目同机共存

| 场景 | 行为 |
|---|---|
| 同项目多个 Codely 窗口 | 每个会话独立目录 `work/sessions/<会话id>/`（独立去重、独立解析进程、独立导图），互不干扰、互不残杀；viewer 默认跟随最新会话，左栏「会话」面板可点击固定查看任意会话，固定后点「● 跟随最新会话」切回 |
| 多项目（如本目录与 `test/`） | 各项目独立部署 `chatgraphic/`，数据完全隔离；serve 端口被占用时**自动 +1 避让**并打印实际地址 |
| 并行解析 | 每次解析使用 mkdtemp 独占临时目录，同机并行无共享状态 |

## 快速开始

前置：已通过 `node chatgraphic/install.js` 注册用户级 Hook（未注册先执行，详见根 README）。直接两步：

```bash
# 1. 启动导图视图（会自动打开浏览器；或手动访问 http://localhost:4830）
node chatgraphic/serve.js

# 2. 在本项目里正常使用 Codely 聊天 —— 每轮结束后数秒~一两分钟内，导图自动生长
```

> 每个项目首次使用时需信任一次：在该项目的 Codely 会话里执行 `/hooks trust-project`（CLI 安全机制，信任指纹按项目记录）。

## 手动补跑历史会话（复盘场景）

对任意 auto-save 转录或实时转录 JSONL 生成导图：

```bash
node chatgraphic/parser.js --transcript .codely-cli/auto-saves/chat-auto-save-xxxx.json
```

补跑结果会覆盖当前导图（全量重解析语义），版本号递增。

## 成本与控制

| 事项 | 说明 |
|---|---|
| 解析成本 | **自动增量（v0.2.0）**：同会话第二次起仅发送「图状态摘要 + 新增轮次」，实测输入从 38K 降到 0.4K 字符、耗时约 1/4，成本近似常数不再随会话线性涨；首次 / 转录被压缩 / 增量失败或疑似丢节点 → 自动回退全量；模型默认 `codely-flash` |
| 转录上限 | 单轮文本截断 `maxTurnChars`；总载荷上限 `maxTotalLeanChars`，超限保头保尾略去中段（解析器会在「待确认」里如实标注） |
| 一键关闭 | `chatgraphic/config.json` 里 `"enabled": false`（Hook 立即静默跳过）；彻底移除 Hook 则执行 `node chatgraphic/install.js --uninstall` |
| 换模型 | `config.json` 的 `"model"` 改为任意已配置模型 id（如 `codely-core` 更强但更慢更贵） |
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
| `~/.codely-cli/settings.json`（用户级） | 由 `chatgraphic/install.js` 注册的 AfterAgent Hook（对所有项目生效，按项目信任） |
| `chatgraphic/hook.js` | 触发器：防递归 / 去重 / 取代旧解析 / 异步派发，毫秒级退出 |
| `chatgraphic/parser.js` | 解析 worker：转录归一化（auto-save JSON / 数组 / 实时 JSONL 容错）→ 精简 → `codely -p` 同链路解析 → graph.json；v0.2.0 起支持增量解析（滚动窗口 + 图状态摘要，全量兜底） |
| `chatgraphic/parse-prompt.md` | 解析提示词：分型 + 三问准入 + 置信分级 + 严格 JSON schema + 上一版 id 稳定性 |
| `chatgraphic/serve.js` | 零依赖本地服务：viewer / graph.json / transcript.json / version / status |
| `chatgraphic/install.js` | 用户级 Hook 注册/移除（`--uninstall` / `--status`），扩展安装方式配套 |
| `chatgraphic/viewer.html` | 只读导图：分层布局、生长动画、节点回链原文、拖拽缩放、导出 PNG/Markdown |
| `chatgraphic/test/` | 22 个离线测试用例（`npm test`，node --test；不调用 codely/LLM） |
| `chatgraphic/work/` | 运行时产物：`sessions/<会话id>/`（graph.json / transcript.json / status.json …）、`current.json`（最新会话指针）、`hook.log`（全链路日志） |

## 与 v0.3 的对齐与边界

- ✅ **轮次级实时**：AfterAgent（每轮 Agent 结束）触发，全量重解析，Hook 不阻塞对话
- ✅ **同链路同边界**：解析即 `codely -p`（同一模型/认证/数据边界），运行在 tmpdir 不加载项目配置；渲染、存储、导出全程本地
- ✅ **三问准入 / 置信分级**：不可执行、非决策、非变更的内容不上图；低置信进「待确认」
- ✅ **证据优先**：任务状态由文件变更/命令执行等真实证据驱动
- ✅ **降级与止损**：`enabled:false` 一键关；解析失败保留上一版导图；历史会话可手动补跑
- ⛔ POC 范围外（v0.3 Phase 2+）：秒级增量解析、节点编辑、版本快照回滚、多会话合并、分享
