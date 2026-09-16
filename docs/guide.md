# 安装与使用指南

前置：本机已安装并登录 `codely` CLI（解析通过 `codely -p` 复用同一模型链路）。

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
- **关于安装目录里的 `.git`**：codely 的扩展安装基于 git clone（按 Release tag 检出），`.git` 是 `codely extensions update` 进行升级的机制基础，属安装器正常行为。workspace 作用域下它位于 `<项目>/.codely-cli/extensions/chatgraphic/.git`——请确保项目 `.gitignore` 包含 `.codely-cli/extensions/`（本仓库已内置），避免嵌套仓库进版本库。
- 每个项目**首次使用**时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`（CLI 安全机制：Hook 信任指纹按项目记录于 `~/.codely-cli/trusted_hooks.json`）。
- **移除**：`node .codely-cli/extensions/chatgraphic/chatgraphic/install.js --uninstall` + `codely extensions uninstall chatgraphic --scope workspace`（用户作用域安装则省略 `--scope workspace`）。
- 注：Codely 1.0.0-rc.60 的扩展 manifest 尚不注册 hooks 字段（已实测），Hook 注册由 install.js 完成。

## 方式二：克隆仓库（与方式一等效，仅代码位置不同）

```bash
git clone git@github.com:weiwei-gu/ChatGraphic.git
cd ChatGraphic
node chatgraphic/install.js     # 注册 Hook 到本项目 .codely-cli/settings.json（本地文件，已 gitignore）
node chatgraphic/serve.js       # 启动导图视图（自动打开 http://localhost:4830）
```

每个项目首次使用时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`。之后每轮结束，导图自动生长（实测单轮出图约 8~15 秒，不阻塞对话）。

> 历史说明：仓库曾内置项目级 Hook（`.codely-cli/settings.json`），现已统一为 `install.js` 的用户级注册，避免与扩展方式双重触发；克隆用户与扩展用户走同一注册机制。

## 日常使用

- **看图**：`serve.js` 启动后浏览器自动打开；左栏「会话」面板可切换/固定任意会话，画布拖拽缩放，节点点击回链对话原文
- **复盘**：`node chatgraphic/parser.js --transcript <会话JSON路径>` 手动补跑历史会话；加 `--full` 强制全量重解析（默认自动增量）
- **成本控制**：`chatgraphic/config.json` 可换解析模型（默认 `codely-flash`）、`"enabled": false` 一键关闭、`"parseMode": "full|incremental|auto"` 控制解析模式
- **排障**：见 [chatgraphic/README.md](../chatgraphic/README.md) 的「成本与控制 / 故障排查」章节（`work/hook.log` 全链路日志）
