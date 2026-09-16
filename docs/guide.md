# 安装与使用指南

前置：本机已安装并登录 `codely` CLI（解析通过 `codely -p` 复用同一模型链路）。

## 方式一：Codely 扩展安装（推荐）

本仓库同时是一个合法的 Codely 扩展（根目录 `gemini-extension.json`）：

```bash
# 1. 安装扩展（从 GitHub 最新 Release 拉取已发布版本；代码进入 ~/.codely-cli/extensions/chatgraphic/）
codely extensions install https://github.com/weiwei-gu/ChatGraphic

# 2. 注册用户级 Hook（写入 ~/.codely-cli/settings.json，一次注册所有项目可用）
node ~/.codely-cli/extensions/chatgraphic/chatgraphic/install.js

# 3. 打开导图视图
node ~/.codely-cli/extensions/chatgraphic/chatgraphic/serve.js
```

每个项目**首次使用**时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`（CLI 安全机制：Hook 信任指纹按项目记录于 `~/.codely-cli/trusted_hooks.json`）。扩展安装态的导图数据存于 `~/.chatgraphic/`，不受扩展升级影响（`CHATGRAPHIC_HOME` 环境变量可覆盖）。

> 移除：`node .../install.js --uninstall` + `codely extensions uninstall chatgraphic`。
> 注：Codely 1.0.0-rc.60 的扩展 manifest 尚不注册 hooks 字段（已实测），Hook 注册由 install.js 完成。

## 方式二：克隆仓库（与方式一等效，仅代码位置不同）

```bash
git clone git@github.com:weiwei-gu/ChatGraphic.git
cd ChatGraphic
node chatgraphic/install.js     # 同样注册用户级 Hook（指向本克隆目录）
node chatgraphic/serve.js       # 启动导图视图（自动打开 http://localhost:4830）
```

每个项目首次使用时，在该项目的 Codely 会话里执行一次 `/hooks trust-project`。之后每轮结束，导图自动生长（实测单轮出图约 8~15 秒，不阻塞对话）。

> 历史说明：仓库曾内置项目级 Hook（`.codely-cli/settings.json`），现已统一为 `install.js` 的用户级注册，避免与扩展方式双重触发；克隆用户与扩展用户走同一注册机制。

## 日常使用

- **看图**：`serve.js` 启动后浏览器自动打开；左栏「会话」面板可切换/固定任意会话，画布拖拽缩放，节点点击回链对话原文
- **复盘**：`node chatgraphic/parser.js --transcript <会话JSON路径>` 手动补跑历史会话
- **成本控制**：`chatgraphic/config.json` 可换解析模型（默认 `codely-flash`）、`"enabled": false` 一键关闭
- **排障**：见 [chatgraphic/README.md](../chatgraphic/README.md) 的「成本与控制 / 故障排查」章节（`work/hook.log` 全链路日志）
