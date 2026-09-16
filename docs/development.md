# 开发、测试与发布

## 本地开发

```bash
npm test         # 22 个用例，全离线（Node 内置 node --test，零依赖；不调用 codely/LLM）
npm run check    # hook / parser / serve / install 四个脚本语法检查
```

测试覆盖：转录归一化（三种真实格式）、轮次构建与精简、归一化规则、JSON 提取、会话定位、数据目录规则、Hook 守卫/去重/取代旧解析（fake-parser 替身）、install 幂等与还原、serve 路由与端口避让。

## CI

`.github/workflows/ci.yml`：push / PR 自动跑测试矩阵（ubuntu + macos × Node 20/24）。

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

`docs/index.html` 是产品描述 v0.3 的发布副本：GitHub Settings → Pages → Branch `main` / Folder `/docs`。更新产品描述后重新 `cp "ChatGraphic产品描述 v0.3.html" docs/index.html` 提交推送即可（Pages 自动重建）。`docs/.nojekyll` 保证 Pages 只原样发布 `index.html`，不渲染本目录下的其他 md 文档。
