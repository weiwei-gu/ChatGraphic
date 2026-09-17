# 开发、测试与发布

## 本地开发

```bash
npm test         # 58 个用例，全离线（Node 内置 node --test，零依赖；不调用 codely/codex/claude）
npm run check    # hook / parser / serve / install / codex-hook / install-codex / claude-hook / install-claude 八个脚本语法检查
```

- 测试入口为 `scripts/run-tests.js`（显式列出 `*.test.js` 交给 `--test`）——不写 glob 是因为 Windows 的 cmd 不展开通配符、Node 20 的 `--test` 也无原生 glob，曾致 CI 的 windows·Node 20 格常红
- 测试覆盖：转录归一化（Codely 三种格式 / Codex rollout / Claude 转录）、轮次构建与精简、归一化规则、JSON 提取、会话定位与引擎路由识别、数据目录规则、Hook 守卫/去重/取代旧解析（fake-parser 替身）、notify 与 Stop payload 解析、config.toml（TOML 顶层键插入）与 settings.json（hooks 数组并存）注册、install 幂等与还原、serve 路由与端口避让、手动模式端到端（stub parser）

## CI

`.github/workflows/ci.yml`：push / PR 自动跑测试矩阵（ubuntu + macos + windows × Node 20/24）。

## 发布流程

`.github/workflows/release.yml`：tag `v*` 触发，自动执行：

1. **版本一致性闸门**（`scripts/check-version.js`）：tag ↔ `package.json` ↔ `gemini-extension.json` 三处版本必须一致
2. **测试**：必须全绿
3. **创建 GitHub Release**（`gh release create --generate-notes`）

发版三步：

```bash
# 1. 同步修改 package.json 与 gemini-extension.json 的 version
git commit -am "release: v0.2.0" && git push
# 2. 打 tag 并推送（之后全自动）
git tag v0.2.0 && git push origin v0.2.0
```

## 安装即已发布版本

`codely extensions install <仓库地址>` 从 GitHub `releases/latest` 解析 tag 并安装**已发布**版本（`--pre-release` 可装预发布版），不会拉取 main 分支未发布代码；用户端通过 `codely extensions update chatgraphic` 升级。

## 静态发布（GitHub Pages）

`docs/index.html` 是产品描述 v0.3 的**发布副本**：相对源文档（仓库根目录 `ChatGraphic产品描述 v0.3.html`）删除了「投入与目标」「阶段规划」两个内部评审章节及其死样式，并做了少量展示优化（标题/页眉去「内部评审」字样、hero 增加 GitHub 仓库按钮、导航补风险与 FAQ、失效交叉引用清理）。更新产品描述后需**手工同步**发布副本（不再逐字 cp）。`docs/.nojekyll` 保证 Pages 只原样发布 `index.html`，不渲染本目录下的其他 md 文档。
