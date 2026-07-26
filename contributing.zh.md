# CatGo 协作开发指南

感谢为 CatGo 贡献代码。本指南介绍开发环境、仓库结构，以及如何在
现有代码上使用 AI 助手（Claude Code / Cursor / Copilot）协作。

---

## 1. 开发环境

```bash
# 1. 克隆项目
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. 安装 JS / pnpm 依赖
pnpm install

# 3. 同时启动桌面前端 + Python 后端
pnpm desktop:serve            # vite :3100, FastAPI :8000

# 4. 或启动 Tauri 原生壳（生产前端 + 原生窗口）
pnpm tauri:dev                # 先 vite build 再开 Tauri 窗口

# 5. 仅后端（只调 Python 工具 / MCP 时用）
cd server
pip install -r requirements.txt
python main.py                # http://localhost:8000
```

想让本地行为和 CI 一致，再补这几步：

```bash
pnpm exec svelte-kit sync           # 重新生成 .svelte-kit/tsconfig.json
cd extensions/rust-wasm && pnpm build && cd -   # wasm-pack 产物（需 Rust）
pnpm run build:doc-chunks           # 构建 src/lib/chat/docs-chunks.json
```

---

## 2. 仓库结构

公开分支只放运行时代码 + 终端用户文档。常改的目录：

| 路径 | 用途 |
|------|------|
| `src/lib/` | 前端库 — Svelte 组件 + TypeScript 工具 |
| `desktop/` | Tauri webview 入口（`index.html`、`App.svelte` 等）|
| `src-tauri/` | Tauri Rust 壳（窗口、IPC、sidecar 二进制、应用图标）|
| `server/` | FastAPI Python 后端、MCP 服务、工作流引擎、插件 |
| `extensions/` | VSCode 扩展 + Rust-WASM 绑定（`@catgo/ferrox-wasm`）|
| `docs/` | VitePress 文档站（guide / modules / tutorials / reference）|
| `tests/vitest/` | 前端单元测试 |
| `tests/playwright/` | 端到端浏览器测试（历史 SvelteKit 残留，目前 best-effort）|
| `scripts/` | 构建脚本 — 图标生成、文档分块、后端打包 |

---

## 3. 测试 & 检查

```bash
pnpm test                  # vitest run — 前端单元测试
pnpm check                 # svelte-check 对 ./tsconfig.json 检查
```

GitHub Actions 的 Tests workflow（`.github/workflows/test.yml`）会跑
单元测试 + Playwright。两个 job 都会在跑测试前重建被 gitignore 的
工件（`.svelte-kit/`、`extensions/rust-wasm/pkg/`、
`src/lib/chat/docs-chunks.json`）—— 本地结果如果跟 CI 不一致，照那些
步骤手动跑一遍。

---

## 4. 跟 AI 编码助手协作

CatGo 代码量大，AI 助手在你**明确指出读哪些文件**时表现最好，否则
它就靠 grep 乱猜。

### 好的 prompt 模板

```
请先读这些文件：
1. <具体路径 1>
2. <具体路径 2>

背景：<一句话描述背景>

任务：<明确动作 — "add"、"fix"、"refactor">

约束：
- <具体要求>
- <具体要求>

验证：跑 `pnpm check` 和 `pnpm test`，把结果发我看。
```

### 先 plan 后写

只要不是一两行的小改，先让 AI 出方案再写：

```
读完 <相关文件>，先告诉我：
1. 要改哪些文件
2. 实施思路
3. 风险点

我确认后再动代码。
```

### 任务对应读哪些文件

| 目标 | 优先让 AI 读 |
|------|---------------|
| 项目总览 | `readme.md` + `docs/guide/` |
| 前端某模块行为 | 对应 `src/lib/<area>/` 目录 |
| 3D 结构查看器 | `src/lib/structure/Structure.svelte` + `src/lib/structure/StructureScene.svelte` |
| 工作流引擎 | `src/lib/workflow/`（前端）+ `server/catgo/workflow/`（后端）|
| MCP 服务 / Agent 工具 | `server/server_claude_code.py` + `server/catgo/mcp/` |
| 构建 / 打包流程 | `vite.desktop.config.ts`、`src-tauri/tauri.conf.json`、`scripts/build-backend.sh` |
| 扩展插件 | `extensions/`（vscode、rust-wasm、uff-relax、vsepr-rs）|

---

## 5. 代码风格

- **前端**：Svelte 5（`$state` / `$derived` / `$effect`），TypeScript 严格模式，ESLint 配置在 `eslint.config.js`。
- **后端**：Python 3.10+，FastAPI，ruff/black。测试在 `server/tests/`。
- **commit 风格**：conventional commits（`feat:`、`fix:`、`chore:`、`docs:`、`test:`、`ci:`）。
- **分支**：在 topic branch 上开发，PR 合到 `main`。

---

## 6. 获取帮助

- 开 issue 前先 [搜一下已有 issue](https://github.com/Hello-QM/catgo-LRG/issues)。
- 较大的设计讨论开 GitHub Discussion。
- README 的 About 列了支持的量化 / DFT 引擎（VASP、ORCA、CP2K、QE、GPAW、DFTB+、SIESTA、LAMMPS）——issue 聚焦在某一个引擎能帮 reviewer 分流。

祝玩得开心！

---

## 贡献许可

- 贡献者必须有权向 CatGo 提交其工作成果。
- 第三方代码必须保留原有声明；将其复制到 CatGo 并不会改变或重新许可该第三方代码。
- 接受一个拉取请求本身并不证明著作权已经转让。
- 对 CatGo 的贡献采用 AGPL-3.0-or-later。
- 所请求的致谢和引用不构成 AGPL 许可的附加条件。
