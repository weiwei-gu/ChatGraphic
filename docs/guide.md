# 安装与使用指南

前置：已安装并登录你想可视化的 CLI——**Codely** / **Codex CLI** / **Claude Code** 任一或全部。三端各自 Hook 触发、各走各自的模型链路解析（Codely → `codely -p`、Codex → `codex exec`、Claude → `claude -p`），互不依赖。

**数据目录规则**（三端一致，按注册的脚本所在位置判定）：

- 脚本位于**扩展安装目录**（`<项目>/.codely-cli/extensions/…` 或 `~/.codely-cli/extensions/…`）→ `~/.chatgraphic/`（不受扩展升级影响）
- 脚本位于**克隆仓库**的 `chatgraphic/` → `<克隆>/chatgraphic/work/`（随仓库走，serve 需从同一克隆启动）
- 均可用 `CHATGRAPHIC_HOME` 覆盖。**三端统一部署推荐**：先装 Codely 扩展，再从扩展目录注册三端 Hook（见下文）——数据全部进 `~/.chatgraphic/`，同一个 viewer 混排展示三端会话。

## 注册作用域对比（含「有没有 `--scope workspace`」）

| 端 | 触发机制 | 注册位置 | 项目级支持 |
|---|---|---|---|
| Codely | AfterAgent Hook | `install.js` **作用域跟随扩展安装位置**：`--scope workspace` → `<项目>/.codely-cli/settings.json`（`$CODELY_PROJECT_DIR` 锚定，跨机器可移植）；用户级安装 → `~/.codely-cli/settings.json` | ✅ 有——扩展以 `--scope workspace` 安装即项目级 |
| Codex CLI | notify（agent-turn-complete） | `~/.codex/config.toml`（用户级） | ❌ 实测 codex-cli 0.141.0：项目级 `.codex/config.toml` 会被加载，但其中 `notify` **不触发**——机制限制，只能全局注册 |
| Claude Code | Stop Hook | `~/.claude/settings.json`（用户级） | ⚪ CLI 原生支持项目级（`.claude/settings.json` 可入库共享 / `.claude/settings.local.json` 本地，多来源 hooks **合并叠加**），安装器暂未提供项目级选项（后续增强） |

## 方式一：Codely 扩展安装（推荐）

本仓库同时是一个合法的 Codely 扩展（根目录 `gemini-extension.json`）。在**目标项目根目录**执行：

```bash
# 1. 安装扩展到本项目（--scope workspace → <项目>/.codely-cli/extensions/；从 GitHub 最新 Release 拉取已发布版本）
codely extensions install https://github.com/weiwei-gu/ChatGraphic --scope workspace

# 2. 注册 Hook（作用域跟随安装位置：--scope workspace → 本项目 .codely-cli/settings.json；用户级安装 → ~/.codely-cli/settings.json）
node .codely-cli/extensions/chatgraphic/chatgraphic/install.js

# 3. 打开导图视图
node .codely-cli/extensions/chatgraphic/chatgraphic/serve.js
```

说明：

- **作用域**：`--scope workspace` 装入本项目（项目级依赖，随项目走）；不加则默认装入 `~/.codely-cli/extensions/`（用户级，全局共享一份）。两种作用域下导图数据都存于 `~/.chatgraphic/`（`CHATGRAPHIC_HOME` 可覆盖），不受扩展升级影响。
- **命令写法**：项目级注册写入 `$CODELY_PROJECT_DIR` 锚定的可移植命令（Codely 在 hook 执行时展开，跨机器/跨克隆位置通用）；用户级注册为本机绝对路径；旧版绝对路径写法仍被识别与兼容
- **关于安装目录里的 `.git`**：codely 的扩展安装基于 git clone（按 Release tag 检出），`.git` 是 `codely extensions update` 进行升级的机制基础，属安装器正常行为。workspace 作用域下它位于 `<项目>/.codely-cli/extensions/chatgraphic/.git`——请确保项目 `.gitignore` 包含 `.codely-cli/extensions/`（本仓库已内置），避免嵌套仓库进版本库。
- 每个项目**首次使用**时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`（CLI 安全机制：Hook 信任指纹按项目记录于 `~/.codely-cli/trusted_hooks.json`）。
- **移除**：`node .codely-cli/extensions/chatgraphic/chatgraphic/install.js --uninstall` + `codely extensions uninstall chatgraphic --scope workspace`（用户作用域安装则省略 `--scope workspace`）。
- 注：Codely 1.0.0-rc.60 的扩展 manifest 尚不注册 hooks 字段（已实测），Hook 注册由 install.js 完成。

## 方式二：克隆仓库（与方式一等效，仅代码位置不同）

```bash
git clone git@github.com:weiwei-gu/ChatGraphic.git
cd ChatGraphic
node chatgraphic/install.js     # 注册 Hook：向上找最近的 .codely-cli 项目注册到其 settings.json；没有则兜底用户级 ~/.codely-cli/settings.json
node chatgraphic/serve.js       # 启动导图视图（自动打开 http://localhost:4830）
```

新克隆目录内没有 `.codely-cli/` 时即注册为**用户级**（对所有 Codely 项目生效）；若克隆放在某个已有 `.codely-cli/` 的项目里，则就近注册到该项目。每个项目首次使用时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`。之后每轮结束，导图自动生长（实测单轮出图约 8~15 秒，不阻塞对话）。

> 历史说明：仓库曾内置项目级 Hook（`.codely-cli/settings.json`），现已统一为 `install.js` 注册（按安装/克隆位置判定作用域），避免与扩展方式双重触发；克隆用户与扩展用户走同一注册机制。

## Codex CLI 接入（实验）

Codex 在每轮结束（`agent-turn-complete`）时经 `notify` 机制触发外部程序：

```bash
# 注册（幂等写入 ~/.codex/config.toml 的 notify 键；--uninstall 移除 / --status 查看）
node chatgraphic/install-codex.js

# 之后正常使用 Codex —— 每轮结束自动解析出图；历史会话手动补跑：
node chatgraphic/codex-hook.js ~/.codex/sessions/<年/月/日>/rollout-*-<thread-id>.jsonl
```

- **零 codely 依赖**：Codex 会话的解析走 `codex exec`（你 `~/.codex/config.toml` 配置的模型/认证）
- **注册作用域**：仅用户级（全局生效）。Codex 虽支持项目级 `.codex/config.toml`，但实测 0.141.0 下其中 `notify` 不触发，故无法做成项目级注册
- `notify` 已被其他程序占用时不覆盖（告警提示手动处理）；`config.json` 的 `"enabled": false` 一键关闭全部三端；数据目录按上文「数据目录规则」判定

## Claude Code 接入（实验）

Claude Code 在每轮响应结束（Stop 事件）时以 JSON 经 stdin 调用 Hook 命令：

```bash
# 注册（幂等写入 ~/.claude/settings.json 的 hooks.Stop；--uninstall 移除 / --status 查看）
node chatgraphic/install-claude.js

# 之后正常使用 Claude Code —— 每轮结束自动解析出图；历史会话手动补跑：
node chatgraphic/claude-hook.js ~/.claude/projects/<项目slug>/<会话id>.jsonl
```

- **零 codely 依赖**：Claude 会话的解析走 `claude -p`（你 `~/.claude/settings.json` 配置的模型/认证）
- **注册作用域**：当前为用户级（全局生效）。Claude Code 原生支持项目级 hooks（`.claude/settings.json` / `.claude/settings.local.json`，多来源合并叠加），安装器暂未提供项目级选项（后续增强）
- hooks 为数组结构，与他人既有 Stop Hook **并存追加**互不影响；`SubagentStop` 等其他事件一律忽略；数据目录按上文「数据目录规则」判定

## 三端统一部署（推荐）

想让 Codely / Codex / Claude 三端会话进**同一个 viewer**：先以 Codely 扩展方式安装（任意作用域），再从**扩展目录**注册三端——三端脚本都位于 `.codely-cli/extensions/` 路径下，数据全部写入 `~/.chatgraphic/`：

```bash
# 以 workspace 作用域为例（用户级安装把路径换成 ~/.codely-cli/extensions/… 即可）
node .codely-cli/extensions/chatgraphic/chatgraphic/install.js        # Codely
node .codely-cli/extensions/chatgraphic/chatgraphic/install-codex.js # Codex（写入 ~/.codex/config.toml）
node .codely-cli/extensions/chatgraphic/chatgraphic/install-claude.js# Claude（写入 ~/.claude/settings.json）
node .codely-cli/extensions/chatgraphic/chatgraphic/serve.js         # 一个 viewer 看三端
```

## 日常使用

- **看图**：`serve.js` 启动后浏览器自动打开；左栏「会话」面板可切换/固定任意会话（Codely / Codex / Claude 三端混排），画布拖拽缩放，节点点击回链对话原文
- **复盘**：`node chatgraphic/parser.js --transcript <转录路径>` 手动补跑历史会话——三种转录自动识别（Codely auto-save / Codex rollout / Claude 转录），或直接用对应 `codex-hook.js` / `claude-hook.js` 传文件路径；加 `--full` 强制全量重解析（默认自动增量）
- **成本控制**：`chatgraphic/config.json` 可换 Codely 引擎解析模型（默认 `codely-flash`）、`"enabled": false` 一键关闭**全部三端**、`"parseMode": "full|incremental|auto"` 控制解析模式；Codex / Claude 引擎分别用各自 CLI 配置的模型（`config.json` 的 `model` 不参与）；超长会话解析慢时可调大 `parseTimeoutMs`（默认 240 秒/次，失败自动重试一次）
- **排障**：见 [chatgraphic/README.md](../chatgraphic/README.md) 的「成本与控制 / 故障排查」章节（`work/hook.log` 全链路日志）
