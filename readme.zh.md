<h1 align="center">
  <img src="desktop/logo.png" alt="CatGo Logo" width="120"><br>
  CatGo
</h1>

<p align="center">
  <strong>AI 驱动的计算材料科学工作台。</strong>
</p>

<p align="center">
  <a href="readme.md">English</a>
</p>

<p align="center">

[![Tests](https://github.com/Hello-QM/catgo-LRG/actions/workflows/test.yml/badge.svg)](https://github.com/Hello-QM/catgo-LRG/actions/workflows/test.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](license)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.19709425-blue)](https://doi.org/10.5281/zenodo.19709425)

</p>

CatGo 是一个集成式桌面应用，把交互式 3D 结构查看器、自然语言 AI 助手（**CatBot**）、可视化 DAG **工作流引擎**和**超算集成**整合到一个工具中。面向催化与表面科学研究：构建 slab 与吸附物、生成 DFT/MD/ML 输入、提交并监控远程作业、做后处理 —— 全部在一个窗口内完成。

> CatGo 借鉴了 **[MatterViz](https://github.com/janosh/matterviz)**（作者 [Janosh Riebesell](https://github.com/janosh)）：3D 结构查看器、元素周期表、以及大量核心 UI 组件都源自 MatterViz，CatGo 在此基础上做了大量修改。在此之上 CatGo 新增了催化计算管线、工作流引擎、超算集成、CatBot 与插件系统。在此向 MatterViz 致以最深的谢意。

<p align="center">
  <img src="static/catgo-viewer.png" alt="CatGo 3D 结构查看器 — Si40Bi4Te8H292C100 显示化学键、晶格轴、组分标签" width="780">
</p>

---

## 🔗 链接

|                       |                                                  |
| --------------------- | ------------------------------------------------ |
| **Web 版** —— 免安装，打开即用 | <https://app.catgo-ucsd.org>                     |
| **教程 / 文档**           | <https://docs.catgo-ucsd.org>                    |
| **下载** —— 预编译版本       | <https://github.com/Hello-QM/catgo-LRG/releases> |
| **源码**                | <https://github.com/Hello-QM/catgo-LRG>          |
| **论坛** —— 提问与讨论       | <https://groups.google.com/g/catgo_official>     |

### 社区

扫码加入 CatGo QQ 群：

<img src="static/qr-qq-group.jpg" alt="CatGo QQ 群二维码" width="200">

---

## ✨ 主要功能

| 模块          | 能力                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **3D 查看器**  | 晶体 · 分子 · 表面 · 轨迹 · 周期镜像原子 · 跨晶胞键渲染 · 可选多面体 · 按元素/按原子配色 · 浅/深/白/黑主题                                                     |
| **CatBot**  | 自然语言操作结构 + 通过 Claude / Codex / Gemini / OpenAI 创建工作流                                                                    |
| **工作流**     | 可视化 DAG 编辑器；一键 Quick-Build 配方（HER / OER / ORR / NRR / CO₂RR / NEB / slow-growth / DOS）                                  |
| **超算**      | SSH 终端、远程文件浏览、作业提交与监控、OTP + 跳板机 + SOCKS5                                                                                |
| **DFT 输入**  | 原生执行: VASP、Quantum ESPRESSO、LAMMPS、CP2K、ORCA。仅 CatBot skill 文本辅助（无 workflow node 执行）: GPAW、ABINIT、SIESTA、DFTB+、Gaussian |
| **机器学习势**   | MACE (含 mace_mp foundation)、CHGNet、M3GNet (via matgl)                                                                   |
| **其他快速计算器** | EMT (effective-medium theory)、xTB / GFN-xTB (半经验紧束缚 DFT，via tblite + xtb-CLI)                                           |
| **分析**      | DOS / PDOS、能带、COHP / ICOHP、d 带中心、电荷密度 cube 等值面、火山图、Gibbs 校正、Bader 电荷标签叠加（读取已计算的 site properties 值）                      |
| **催化**      | OER / HER / ORR / CO₂RR / NRR 反应路径、ICONST slow-growth 约束模板、C–N 偶联反应网络                                                   |

---

## 🔧 能力详解

### 结构构建与操作

- **交互式编辑** —— pencil 模式画原子（从一个原子拖到位置即种新原子）、右键菜单单原子增删替换移动、方向键 / W-S 旋转选中原子、框选多原子、簇生成（`add_cluster`）用 ASE 二十面体/八面体/立方八面体/FCC/HCP/十面体加上一小批金属氧化物簇（Pt₂O₂、CeO₂ 三聚体、TiO₂ 锐钛矿 8 原子、Al₂O₃ 5 原子）
- **切面** —— Miller 指数 slab cutter，含原胞约化、层数+真空层控制、超胞扩展、冻结层预设以做吸附
- **吸附物** —— alpha-shape 吸附位点（top / bridge / hollow / FCC / HCP）、单分子按键长偏移放置、C-N / C-C / N-N 偶联双吸附受控间距、Packmol 水层
- **构建工具**（有专用面板）—— 晶格变换（矩阵超胞）、moiré 双层、纳米管 (CNT / BNNT / 手性指数)、异质结构堆叠（含晶格匹配）、替位掺杂（单/枚举所有构型）、悬挂键伪氢钝化、加水层、吸附物放置
- **CatBot skill 辅助构建**（无专用面板，仅文本驱动）—— 点缺陷、层间嵌入、系统元素替换、应变

### 检查与分析

- **对称性** —— moyo 驱动空间群+ Wyckoff 位置识别、原胞↔常规胞、按对称等价位染色
- **测量** —— 两原子距离、三原子角度、持久测量浮层
- **电荷密度** —— cube 文件等值面渲染 (web worker)、正/负等值面、可切正交平面、原子上叠加 Bader 电荷标签
- **属性染色** —— 配位数、Wyckoff 轨道、Bader 电荷、用户表达式；支持元素隐藏、prop 值过滤、单原子隐藏
- **轨迹播放** —— MD / NEB / IRC 轨迹时间轴、逐帧键联、能量/力/原子属性 overlay、帧导出

### 计算与机器学习势

<p align="center">
  <img src="static/catgo-workflow.png" alt="CatGo 可视化工作流编辑器 — INPUT / CALCULATION / TOOLS / LOGIC / ANALYSIS 节点面板，画布上含 Free Energy 节点" width="780">
</p>

- **DFT 引擎** —— 工作流执行器原生驱动: VASP、Quantum ESPRESSO、LAMMPS、CP2K、ORCA。仅 CatBot skill 文本辅助（无 workflow node 执行）: GPAW、ABINIT、SIESTA、DFTB+、Gaussian。原生引擎支持 geo_opt / single_point / cell_opt / freq / NEB / TS-search / MD / slow-growth 节点，按节点预设参数
- **ML 势** —— MACE（含 mace_mp foundation 模型）、CHGNet、M3GNet (via matgl)；几何优化、单点能、力评估、NEB 端点精化、DFT 前 pre-screen
- **其他快速计算器** —— EMT (ASE 内置 effective-medium theory)、xTB / GFN-xTB (半经验紧束缚 DFT，tblite GFN2/GFN1/IPEA1 + xtb-CLI GFN0/GFN-FF)。非机器学习势，但同角色：DFT 前廉价 pre-screen
- **工作流引擎** —— DAG 执行器，HPC 提交、依赖解析、收敛监控、实时作业状态、失败任务 AI 诊断

### 后处理

- **电子结构** —— DOS / PDOS、d 带中心、轨道投影、能带（含高对称 k-path）、COHP / ICOHP via LOBSTER。外部 `bader` 运行后将 bader_charge 写入 site properties，可在查看器原子上叠加标签；CatGo 本身不跑 Bader 积分
- **催化** —— Gibbs 自由能图（含 ZPE+热校正）、OER / NRR / CO₂RR 催化模块 (`server/workflow/catalysis/`)，HER / ORR 通过 `free_energy` workflow node + target= 关键字、按描述符 volcano plot
- **振动与热力学** —— VASP / ORCA 输出频率解析、ZPE、用户指定 T/P 下熵、IR 强度。Phonopy 输出解析器存在 (`src/lib/structure/parsers/phonopy.ts`)，但 Phonopy 本身外部跑——CatBot 有 `phonopy` skill 草拟运行，无 in-app 执行器

### HPC 集成

- **连接** —— SSH 密钥、密码、OTP（KAUST Shaheen 风 key+OTP）、密码+OTP、SOCKS5 代理、跳板机
- **浏览** —— 远端文件树、Monaco 编辑器原地编辑 INCAR / KPOINTS / 作业脚本、远端 CIF / POSCAR / TRAJ / HDF5 在 Threlte 查看器直接预览、无大小限制 scp 上传下载
- **提交+监控** —— SLURM / PBS / LSF / SGE adapter、按分区模板、队列状态轮询、log tail、收敛点流式推送、FAILED / REMOTE_ERROR 任务 AI 诊断
- **终端** —— 每主机一个 xterm.js PTY、CWD 广播到文件浏览、多 tab + 分屏

### AI 代理 (CatBot)

<p align="center">
  <img src="static/catgo-catbot.png" alt="CatGo CatBot 聊天面板 — Claude Code 提供商，工作流 / 结构 / 分析快捷提问" width="780">
</p>

- **提供商** —— 本地 Ollama、SDK agents（Claude Code、Gemini CLI、Codex CLI），以及通过 OpenAI-compatible streaming 接入的 API providers（DeepSeek、Qwen、Kimi、Zhipu GLM、Gemini）
- **MCP 工具** —— `catgo_structure`、`catgo_fetch`、`catgo_workflow`、`catgo_quickbuild`、`catgo_analyze`、`catgo_view`、`catgo_catalysis`、`catgo_skills`、`catgo_workflow_engine`、`catgo_diagnose`、`catgo_file`、`catgo_system`
- **Skills** —— 服务端 reference 文档 CatBot 按需读 (workflow_builder、atom_ops、cluster_ops，加 ~40 个 DFT 代码 skill)
- **Quick-build hook** —— UI 按钮条 + HTTP 端点，0 LLM round-trip 构 workflow (~200 ms)
- **Session resume** —— `record_session` 写本地历史索引（reload 仍在），点条目继续同一 Claude/Codex/Gemini session id

### 插件系统

- **Plugin Hub** —— 从 registry 安装/启用/禁用 plugin；内置 reader 含 VASP `vaspout.h5`、`PROCAR`、`vasprun.xml` bands、COHPCAR
- **Plugin API** —— Python `catgo-plugin.json` manifest，带后端 calculator、structure reader、analyzer、workflow node；示例 plugin（Lennard-Jones calculator、charge-coloring）
- **VS Code 插件** —— 编辑器内预览 CIF / POSCAR / XYZ / TRAJ / HDF5（右键 → *Render with CatGo* 或 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>）

### 结构 I/O

- **导入** —— 拖放、粘贴、OPTIMADE 搜索（Materials Project / MC3D / Alexandria / MaterialsCloud / OMDB / 2DMatPedia）、PubChem 分子搜索、文件浏览、HPC 远端文件读取
- **导出** —— POSCAR、CIF、XYZ、extxyz、mol2、PDB、NEB image set、完整 workflow JSON

---

## 📦 获取 CatGo

预编译产物发布在 [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases)：

- **桌面应用** —— Tauri 构建，内置后端 + agent + shell。
- **IDE 扩展** —— 跨平台 `.vsix`（Windows / macOS / Linux）。可装进 **VS Code、Cursor 及其他 VS Code 兼容 IDE**，把完整 CatGo 工作台（含内置后端与 shell）带进编辑器。
- **Linux server 二进制** —— 给远程 / 超算主机用的无界面后端。
- **HPC bundle** —— 用于集群部署。

### Web 版 —— 仅前端

<https://app.catgo-ucsd.org> 是一个托管的静态单页应用（SvelteKit `adapter-static`），**只跑前端功能**：浏览器内结构查看、编辑、3D 可视化，零安装。

它**不含**后端：没有 DFT/MD 执行、没有 HPC 作业提交、没有 AI agent 任务执行。这些需要桌面应用或 IDE 扩展（它们内置后端与集成 shell）。用 Web 版查看和编辑结构；要跑真实计算请用完整版本。

### 内置 shell

桌面应用与 IDE 扩展都自带**集成 shell** —— 不离开 CatGo 即可驱动作业、查看输出、移动文件。在 shell 里 **Ctrl + 单击**一个结构文件路径（POSCAR、CIF、XYZ、extxyz、轨迹文件 …）即可直接在 3D 查看器中打开，无需手动上传。

下面的内容介绍如何**从源码**运行 CatGo（开发用)。

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 20，配 **pnpm**
- **Python** ≥ 3.10（推荐 Conda）
- **Git**
- [**Rust**](https://rustup.rs/)
- [**wasm-pack**](https://wasm-bindgen.github.io/wasm-pack/installer/) (要求**Rust** ≥ 1.30.0)

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. 前端依赖
pnpm install

# 3. Python 环境
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt
```

三种运行方式：

**方式 A — 浏览器开发模式（最快迭代）**

```bash
pnpm build:wasm               # Compile Rust to WebAssembly
pnpm desktop:serve            # vite :3100，FastAPI :8000
```

浏览器打开 <http://localhost:3100>，改代码即时热更新。

**方式 B — Tauri 原生壳（日常推荐）**

```bash
# 首次：装 Rust toolchain + Tauri 依赖
# (https://tauri.app/start/prerequisites/)
pnpm tauri:dev                # 先 vite build 再开原生窗口
```

`tauri:dev` 后端仍跑在 :8000，前端用原生 WebKit / WebView2 窗口渲染。
跑生产 frontend 跳过 Svelte 5 dev 模式 reactivity tracking + HMR client
开销，比浏览器模式顺滑约 40%。Tauri 壳还把 Python 后端当 sidecar
托管，关窗口 = 后端也干净退出。

**方式 C — 打包成安装包（.dmg / .msi / .deb / .AppImage）**

```bash
pnpm tauri:build              # 仅桌面 app，后端单独跑
pnpm bundle                   # app + Python 后端（PyInstaller 打 sidecar）
pnpm bundle:windows           # 跨平台变体
pnpm bundle:mac-arm
```

产物在 `src-tauri/target/release/bundle/`，双击即用，后端自动作为 sidecar 启动。

运行起来后（任选一种），把 CIF / POSCAR / XYZ / extxyz / mol2 / pdb / traj 文件拖进查看器，或直接对 CatBot 说："从 Materials Project 拉一个 Cu，切 (100) slab"。

---

## 🤖 CatBot 示例

```text
"从 Materials Project 获取 TiO2 锐钛矿，做 2×2×2 超胞，
 沿 (101) 切 slab，3 层，真空层 15 Å。"

"找吸附位点，把 CO 放到最稳定的 hollow 位。"

"用 PBE+D3 生成 VASP 优化输入，ENCUT=520，ISMEAR=0。"

"创建工作流：geo_opt → single_point → DOS 分析，
 提交到 Shaheen workq 队列，64 核。"

"在 Cu(111) 上放 CO 和 NH2，距离 3.5 Å，做 C-N 偶联慢增长，
 帮我配 ICONST，建议 ENCUT 和 k-mesh。"
```

### 对话式生成 workflow 的原理

CatGo 有两条 workflow 构建路径：

1. **可视化编辑器** — 从左侧 palette（Input / Calculation / Tools /
   Logic / Analysis）拖节点，在画布连线，然后运行图。
2. **CatBot 面板** — 输入类似"给我生成 Pt(111) 上 HER 自由能 workflow，
   含三个中间体"的请求；CatBot 通过 CatGo 的 MCP workflow API 构建 DAG。

应用内 CatBot 使用正在运行的后端 HTTP MCP 端点。它不注册终端
catbot-plugin 使用的那套 stdio MCP server。

```text
你 ── chat ─▶ CatBot 面板                        (src/lib/chat/*)
              │
              ▼
        agent bridge                            (dev 模式: vite-plugin-agent-bridge.ts；
              │                                  打包版: desktop bridge)
              │
              ▼
        provider adapter                        (Claude 路径: @anthropic-ai/claude-agent-sdk query())
              │
              │  MCP server URL: http://localhost:<port>/api/mcp/
              │  加 X-CatGo-Tab-Id，让工具结果回到当前查看器 tab
              ▼
        server/catgo/routers/mcp_http.py
              │
              │  复用 consolidated tool schema / handlers
              ▼
        server/catgo/mcp_tools/server_claude_code.py
              │
              ├── catgo_structure   — 查看器结构创建/编辑/检查
              ├── catgo_fetch       — Materials Project / OPTIMADE / PubChem
              ├── catgo_workflow    — 批量增删 DAG 节点 + 边
              ├── catgo_quickbuild  — 一次性 recipe 构建器
              ├── catgo_analyze     — DOS / 能带 / COHP / 吸附位点分析
              ├── catgo_view        — 查看器状态与截图
              ├── catgo_catalysis   — 自由能图、火山图
              ├── catgo_file        — 本地 + 远程文件 I/O
              └── catgo_system      — 环境 / 会话 / 设置
```

MCP 工具会修改后端状态（workflow DAG、查看器 panel 状态或 HPC 作业记录）。
前端通过正常的应用状态与流式响应路径看到这些更新，所以用户看到的是：
在 CatBot 里打一段话，画布上出现可编辑的 workflow 图。

另外还有一条独立的 **终端 plugin** 路径：

```text
Claude Code terminal
  └── catbot-plugin/.mcp.json
        └── ${CLAUDE_PLUGIN_ROOT}/server/mcp_server.py
              └── symlink 到 server/mcp_server.py
                    └── catgo.mcp_tools.server
```

这条 stdio server 暴露更细粒度的 MCP 工具集合，并包含
`catgo_create_tool`、`catgo_save_tool` 这类动态工具生命周期命令。
它适合终端 agent 使用，但不是应用内 CatBot 面板的同一套 MCP surface。

浏览器 UI 不直接调用模型 API。模型流量由本地 agent bridge / provider
adapter 管理；CatGo 操作则通过后端 MCP 端点执行。

### AI 提供商配置

在 CatBot 设置里选择任意可用 provider：

| Provider 类型       | 选项                                  | 配置方式                                                                                                                                                             |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本地**            | Ollama                              | 连接 `http://127.0.0.1:11434`，不需要 API key。                                                                                                                         |
| **SDK agents**    | Claude Code、Gemini CLI、Codex CLI    | 安装对应 CLI。Claude 可用 `ANTHROPIC_API_KEY`；Gemini 可用 CLI OAuth 或 `GEMINI_API_KEY`；Codex 使用 Codex SDK / CLI 的认证流程。                                                    |
| **API providers** | DeepSeek、Qwen、Kimi、Zhipu GLM、Gemini | 在设置中填 API key，或用服务端环境变量：`DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPUAI_API_KEY`、`GEMINI_API_KEY`。这些走 CatGo 的 OpenAI-compatible streaming 路径。 |

API providers 的 Base URL 可以在设置里改，所以需要时也能指向其它
OpenAI-compatible endpoint。

---

## 🗂️ 项目结构

```
catgo-LRG/
├── src/                      # SvelteKit + Svelte 5 前端
│   └── lib/
│       ├── structure/        # 3D 查看器（Threlte / Three.js）
│       ├── workflow/         # DAG 编辑器与节点定义
│       ├── chat/             # CatBot（应用内 AI 循环）
│       └── api/              # Tauri / desktop / browser 路由
├── server/                   # FastAPI Python 后端
│   ├── routers/              # REST API 端点
│   ├── workflow/engines/     # VASP / QE / LAMMPS / CP2K / ORCA …
│   ├── mcp_tools/            # 给 AI 代理用的 MCP 定义
│   └── catgo/                # 工作流引擎与超算 submitter
├── src-tauri/                # Rust + Tauri 桌面外壳
├── desktop/                  # 独立 Vite 开发前端
├── extensions/
│   ├── rust/                 # Rust → WASM（成键、超胞、切面）
│   └── vscode/               # VS Code 插件
├── catbot-plugin/            # CatBot 代理 prompt 与工具
└── plugins/                  # 用户插件（分析、查看器 …）
```

---

## 🛠️ 开发命令

| 命令                    | 说明                                      |
| --------------------- | --------------------------------------- |
| `pnpm desktop:serve`  | 前端 (:3100) + Python 后端 (:8000) 一起启动（推荐） |
| `pnpm desktop:dev`    | 仅前端                                     |
| `pnpm tauri:dev`      | 完整 Tauri 桌面应用                           |
| `pnpm check`          | Svelte / TypeScript 类型检查                |
| `pnpm test`           | Vitest 单元测试                             |
| `cd server && pytest` | Python 后端测试                             |

---

## 🧩 VS Code 插件

[`extensions/vscode/`](extensions/vscode/) 下独立的 VS Code 插件可在编辑器内直接预览 CIF / POSCAR / XYZ / TRAJ / HDF5 文件（右键 → *Render with CatGo*，或 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>）。

---

## 🙏 致谢

如果没有大量开源项目的工作，CatGo 不可能存在。在此特别感谢：

### 基础来源

- [**MatterViz**](https://github.com/janosh/matterviz)，作者 [Janosh Riebesell](https://github.com/janosh) —— 3D 结构查看器、元素周期表组件、元素数据、配色方案、以及大量 UI 模式都源自 MatterViz。CatGo 在此基础上做了大量修改，但根基仍来自 MatterViz。

### 前端栈

[Svelte 5](https://svelte.dev) · [SvelteKit](https://kit.svelte.dev) · [Tauri](https://tauri.app) · [Vite](https://vitejs.dev) · [pnpm](https://pnpm.io) · [three.js](https://threejs.org) · [threlte](https://threlte.xyz) · [d3](https://d3js.org) · [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [xterm.js](https://xtermjs.org) · [moyo](https://github.com/spglib/moyo)（晶体对称性）。

### Python 后端

[FastAPI](https://fastapi.tiangolo.com) · [pymatgen](https://pymatgen.org) · [ASE](https://wiki.fysik.dtu.dk/ase/) · [Open Babel](https://openbabel.org) · [Packmol](https://m3g.github.io/packmol/) · [Phonopy](https://phonopy.github.io/phonopy/) · [Spglib](https://spglib.readthedocs.io) · [RDKit](https://www.rdkit.org)。

### 机器学习势函数

[MACE](https://github.com/ACEsuit/mace) · [CHGNet](https://github.com/CederGroupHub/chgnet) · [M3GNet / MatGL](https://github.com/materialsvirtuallab/matgl) · [ORB](https://github.com/orbital-materials/orb-models) · [FAIR-Chem / UMA](https://github.com/facebookresearch/fairchem) · [DeePMD-kit](https://github.com/deepmodeling/deepmd-kit) · [xTB](https://xtb-docs.readthedocs.io)。

### DFT / MD 引擎（输入 + 后处理）

[VASP](https://www.vasp.at) · [Quantum ESPRESSO](https://www.quantum-espresso.org) · [LAMMPS](https://lammps.org) · [CP2K](https://www.cp2k.org) · [ORCA](https://www.faccts.de/orca/) · [GPAW](https://wiki.fysik.dtu.dk/gpaw/) · [ABINIT](https://www.abinit.org) · [SIESTA](https://siesta-project.org) · [DFTB+](https://dftbplus.org) · [Gaussian](https://gaussian.com)。

### AI 代理

[Anthropic Claude](https://www.anthropic.com) / [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · [OpenAI Codex CLI](https://github.com/openai/codex) · [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) · [Ollama](https://ollama.com) · [DeepSeek](https://www.deepseek.com) · [Qwen](https://help.aliyun.com/zh/model-studio/) · [Kimi](https://platform.moonshot.ai) · [Zhipu GLM](https://open.bigmodel.cn) · [Gemini API](https://ai.google.dev)。

### 测试与工具链

[Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [pytest](https://pytest.org) · [Deno](https://deno.land)（lint/format）。

向以上每一个项目的维护者致敬 —— CatGo 所支持的科研工作完全是站在你们的肩膀上的。

---

## 📚 引用

如在论文中使用 CatGo，请引用 Zenodo 记录：

```bibtex
@software{catgo,
  title  = {CatGo: Bridging CLI Coding Agents with Interactive Structure and Workflow Management for Computational Chemistry},
  doi    = {10.5281/zenodo.19709425},
  url    = {https://doi.org/10.5281/zenodo.19709425},
}
```

---

## 📄 许可证

CatGo 采用 [**GNU Affero General Public License v3.0 或更高版本**](license)（AGPL-3.0-or-later）授权。可自由使用、修改、再分发；以网络服务形式运行修改版时，须按同等条款向用户公开修改后的源代码。

---

<p align="center">
  Developed at <a href="https://wanlulilab.ucsd.edu/">Dr. Wanlu Li Lab @ UCSD</a>。
</p>
