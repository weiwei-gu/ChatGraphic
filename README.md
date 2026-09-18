# ChatGraphic

[English](README.md) | [中文](README.zh-CN.md)

> Watch your conversation grow into a mind map in real time — session mind maps for three CLIs (Codely / Codex CLI / Claude Code) · v0.3.0 ships with the TerminalServer web terminal: terminal + map side by side

ChatGraphic is a companion visualization tool for AI coding CLIs (currently [Codely](https://codely-docs.tuanjie.cn), Codex CLI, and Claude Code): conversations are parsed **while they are happening** — options, the final choice, tasks, decisions, and file changes automatically grow into a single mind map. Finish the chat, get the map. Discussions never lose track, and results are here to stay. Each CLI's hook triggers parsing over its own model link; all data is stored locally and browsed in one shared viewer. Since v0.3.0 the repo ships a [TerminalServer](TerminalServer/) submodule: chat inside the browser terminal, flip one toolbar switch, and the live map unfolds on the same page — `--workspace` even bootstraps the Codely extension environment for a new project in one command.

- Online product page: <https://weiwei-gu.github.io/ChatGraphic/> (product description v0.3, statically published)
- Quick start:

```bash
codely extensions install https://github.com/weiwei-gu/ChatGraphic --scope workspace
node .codely-cli/extensions/chatgraphic/chatgraphic/install.js     # register hooks (scope follows the install: project-level here)
```

`--scope workspace` installs the extension into **this project's** `.codely-cli/extensions/` (fetched from the latest Release); omit it to install into `~/.codely-cli/extensions/` (one shared copy for all projects). To view the map: `node .codely-cli/extensions/chatgraphic/chatgraphic/serve.js`.

**Codex CLI / Claude Code users** (after cloning the repo):

```bash
node chatgraphic/install-codex.js    # Codex: writes the notify hook into ~/.codex/config.toml
node chatgraphic/install-claude.js   # Claude Code: writes hooks.Stop into ~/.claude/settings.json
```

See **[docs/guide.md](docs/guide.md)** for the full onboarding & removal details of all three CLIs. Hook scopes: Codely follows the extension install location (`--scope workspace` = project-level); Codex / Claude currently register globally at user level (project-level notify turned out not to work with Codex; Claude supports project-level hooks natively but the installer doesn't offer it yet) — see the comparison table in the guide. Installation and usage details (trust mechanism, data directories, cost control) are also in the guide.

**Web terminal integration** (v0.3.0+, works right after cloning):

```bash
git clone --recurse-submodules https://github.com/weiwei-gu/ChatGraphic.git
cd ChatGraphic/TerminalServer
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py                                  # open in browser → toggle "Session Map" in the toolbar
./venv/bin/python app.py --workspace ~/code/some-project  # one-shot extension install + hook registration, terminal lands in that directory
```

## Repository layout

```
├── ChatGraphic产品描述 v0.3.html   Product description document (latest, source of requirements; Chinese)
├── gemini-extension.json          Codely extension manifest (entry point for extensions install)
├── package.json / scripts/        Test & release scripts (npm test / version consistency check)
├── .github/workflows/             CI (test matrix) & Release (tag → GitHub Release)
├── chatgraphic/                   POC implementation (component details in chatgraphic/README.md)
│   ├── hook.js                    AfterAgent trigger: dedupe / supersede stale parses / fast exit
│   ├── parser.js                  Parsing worker: lean transcript → same-link parsing (routed by transcript source: Claude→claude -p / Codex→codex exec / others→codely -p) → graph.json (auto incremental: graph state + new turns)
│   ├── parse-prompt.md            Parsing prompt: node types + three-question admission + confidence tiers
│   ├── serve.js / viewer.html     Local read-only view server & map UI (grow animations / links back to transcript / export)
│   ├── install.js                 User-level hook registration / removal
│   ├── codex-hook.js              Codex notify trigger (agent-turn-complete → same-link parsing)
│   ├── install-codex.js           Codex notify registration / removal (writes ~/.codex/config.toml)
│   ├── claude-hook.js             Claude Code Stop hook trigger (stdin JSON → same-link parsing)
│   ├── install-claude.js          Claude Stop hook registration / removal (writes ~/.claude/settings.json)
│   ├── config.json                Toggles / parsing model / port / truncation limits
│   └── test/                      59 offline test cases (node --test, zero dependencies)
├── TerminalServer/                 Web terminal service (git submodule): terminal + session map on one page, --workspace bootstrap (details in TerminalServer/README.md)
└── docs/                          Published product page (index.html = GitHub Pages) + long-form docs
    ├── guide.md                   Installation & usage guide
    ├── architecture.md            Architecture, component responsibilities, design notes
    └── development.md             Development, testing & release workflow
```

## Documentation index

| Doc | Contents |
|---|---|
| [docs/guide.md](docs/guide.md) | Extension vs. clone installation, trust mechanism, daily usage & retrospectives |
| [docs/architecture.md](docs/architecture.md) | Data-flow architecture, component responsibilities, design notes (three-question admission / same link & boundary), roadmap |
| [docs/development.md](docs/development.md) | Testing, CI/CD, release process, GitHub Pages publishing |
| [chatgraphic/README.md](chatgraphic/README.md) | POC component details, cost & control, troubleshooting |
| [TerminalServer/README.md](TerminalServer/README.md) | Web terminal integration: session map panel, --workspace bootstrap, draggable splitter |
