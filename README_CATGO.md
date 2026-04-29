<h1 align="center">
  <sub><img src="static/favicon.svg" alt="Logo" width="40px"></sub> CatGO
</h1>

<p align="center">
  <strong>AI-Driven Computational Materials Science Toolkit</strong><br>
  <strong>AI 驱动的计算材料科学工具包</strong>
</p>

---

## What is CatGO? | CatGO 是什么？

CatGO is an all-in-one platform for computational materials science that combines interactive 3D visualization, AI-assisted workflow automation, and HPC integration.

CatGO 是一个一体化的计算材料科学平台，集成了交互式 3D 可视化、AI 辅助工作流自动化和超算集成。

**Key features | 核心功能：**

| Feature | 功能 | Description | 描述 |
|---------|------|-------------|------|
| 3D Structure Viewer | 3D 结构查看器 | Visualize crystals, molecules, surfaces, trajectories | 可视化晶体、分子、表面、轨迹 |
| CatBot AI Assistant | CatBot AI 助手 | Natural language → structure operations + workflow creation | 自然语言 → 结构操作 + 工作流创建 |
| DAG Workflow Engine | DAG 工作流引擎 | Chain DFT/MD/ML calculations with visual editor | 可视化编辑器串联 DFT/MD/ML 计算 |
| HPC Integration | 超算集成 | SSH terminal, file browser, job management | SSH 终端、文件浏览器、作业管理 |
| DFT Input Generation | DFT 输入生成 | VASP, QE, LAMMPS, CP2K, ORCA | 支持 VASP、QE、LAMMPS、CP2K、ORCA |
| ML Potentials | 机器学习势函数 | MACE, CHGNet, M3GNet, XTB, EMT | 内置 MACE、CHGNet、M3GNet 等 |
| Electronic Analysis | 电子结构分析 | DOS, Band structure, COHP, Bader charge | DOS、能带、COHP、Bader 电荷 |
| Catalysis Tools | 催化分析工具 | OER/HER/CO2RR/NRR overpotential, volcano plots | 过电位、火山图 |

---

## Quick Start | 快速开始

### Prerequisites | 前置条件

- **Node.js** >= 20 + **pnpm**
- **Python** >= 3.10 (recommend Conda/Mamba)
- **Git**

### Installation | 安装

```bash
# 1. Clone the repo | 克隆仓库
git clone https://github.com/leshenzhang/catgo.git
cd catgo

# 2. Install frontend dependencies | 安装前端依赖
pnpm install

# 3. Create Python environment | 创建 Python 环境
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt

# 4. Start the app | 启动应用
conda run -n catgo pnpm desktop:serve
```

This starts both the frontend (port 3100) and Python backend (port 8000).

这会同时启动前端（端口 3100）和 Python 后端（端口 8000）。

### First Steps | 第一步

1. Open **http://localhost:3100** in your browser | 在浏览器打开
2. Load a structure: drag & drop a CIF/POSCAR/XYZ file onto the viewer | 拖放结构文件到查看器
3. Or use CatBot: click the chat icon and ask "fetch TiO2 from Materials Project" | 或使用 CatBot 获取结构

---

## Using CatBot (AI Assistant) | 使用 CatBot（AI 助手）

CatBot is the built-in AI assistant that can manipulate structures, generate DFT inputs, and create workflows through natural language.

CatBot 是内置的 AI 助手，可以通过自然语言操作结构、生成 DFT 输入、创建工作流。

### Setup | 配置

CatBot supports multiple AI providers. Set up at least one:

CatBot 支持多种 AI 提供商，至少配置一个：

| Provider | Setup | 配置方式 |
|----------|-------|---------|
| **Claude** (recommended) | Install [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), set API key | 安装 Claude Code CLI，设置 API key |
| **OpenAI** | Set `OPENAI_API_KEY` environment variable | 设置环境变量 |
| **Anthropic** (direct) | Set `ANTHROPIC_API_KEY` in CatBot settings | 在 CatBot 设置中填入 |

### Example Conversations | 对话示例

#### Structure Building | 构建结构

```
You:  "Fetch Cu from Materials Project and cut a (100) slab, 3 layers, 15 Å vacuum"
CatBot: [calls catgo_fetch_crystal → catgo_generate_slab → updates viewer]

你：  "从 Materials Project 获取 Cu，切 (100) 面，3 层，15 Å 真空层"
CatBot: [调用 catgo_fetch_crystal → catgo_generate_slab → 更新查看器]
```

#### Adsorbate Placement | 放置吸附物

```
You:  "Find adsorption sites, then place CO on a hollow site"
CatBot: [calls catgo_adsorption_sites → catgo_adsorption_place]

你：  "找吸附位点，然后在 hollow 位放 CO"
CatBot: [调用 catgo_adsorption_sites → catgo_adsorption_place]
```

#### Dual Adsorbate for C-N Coupling | 双吸附物（C-N 偶联）

```
You:  "Place CO and NH2 on the surface with ~3.5 Å binding distance for coupling study"
CatBot: [calls catgo_place_dual_adsorbates with target_distance=3.5]

你：  "在表面放 CO 和 NH2，binding 距离约 3.5 Å，用于偶联研究"
CatBot: [调用 catgo_place_dual_adsorbates，target_distance=3.5]
```

#### DFT Input Generation | DFT 输入生成

```
You:  "Generate VASP input for geometry optimization with PBE, ENCUT=520"
CatBot: [calls catgo_vasp_generate → returns INCAR + POSCAR + KPOINTS]

你：  "用 PBE 生成 VASP 几何优化输入，ENCUT=520"
CatBot: [调用 catgo_vasp_generate → 返回 INCAR + POSCAR + KPOINTS]
```

#### Workflow Creation | 创建工作流

```
You:  "Create a workflow: geometry optimization → single point → DOS analysis"
CatBot: [calls catgo_workflow with create → add_node × 3 → connect × 2]

你：  "创建工作流：几何优化 → 单点能 → DOS 分析"
CatBot: [调用 catgo_workflow: create → add_node × 3 → connect × 2]
```

#### C-N Coupling Reaction Network | C-N 偶联反应网络

```
You:  "List all possible C-N coupling paths between CO, CHO and NH2, N"
CatBot: [calls catgo_cn_coupling_network → returns feasible paths with ICONST templates]

你：  "列出 CO、CHO 与 NH2、N 之间所有可能的 C-N 偶联路径"
CatBot: [调用 catgo_cn_coupling_network → 返回可行路径和 ICONST 模板]
```

---

## Available CatBot Tools | CatBot 可用工具

### Structure Manipulation | 结构操作

| Tool | 工具 | Description | 描述 |
|------|------|-------------|------|
| `catgo_fetch_crystal` | 获取晶体 | Fetch from Materials Project, Alexandria, etc. | 从数据库获取 |
| `catgo_fetch_molecule` | 获取分子 | Fetch from PubChem by name/formula/SMILES | 从 PubChem 获取 |
| `catgo_generate_slab` | 生成表面 | Cut surface along Miller indices | 沿密勒指数切面 |
| `catgo_supercell` | 超胞 | Create supercell (na × nb × nc) | 创建超胞 |
| `catgo_add_atom` | 添加原子 | Add atom at [x, y, z] | 在指定位置添加原子 |
| `catgo_delete_atoms` | 删除原子 | Delete atoms by indices | 按索引删除原子 |
| `catgo_move_atom` | 移动原子 | Move atom to new position | 移动原子到新位置 |
| `catgo_adsorption_sites` | 吸附位点 | Find surface sites (Alpha Shape) | 寻找表面吸附位点 |
| `catgo_adsorption_place` | 放置吸附物 | Place adsorbate at site | 在位点放置吸附物 |
| `catgo_place_dual_adsorbates` | 双吸附物 | Place two adsorbates with controlled distance | 放置两个吸附物并控制距离 |
| `catgo_water_layer` | 水层 | Add water layer to slab | 在表面加水层 |
| `catgo_doping` | 掺杂 | Substitutional doping | 替位掺杂 |
| `catgo_build_defect` | 缺陷 | Point defects (vacancy, substitution) | 点缺陷 |

### DFT & Computation | DFT 与计算

| Tool | 工具 | Description | 描述 |
|------|------|-------------|------|
| `catgo_vasp_generate` | VASP 输入 | Generate INCAR + POSCAR + KPOINTS | 生成 VASP 输入文件 |
| `catgo_qe_generate` | QE 输入 | Generate Quantum ESPRESSO input | 生成 QE 输入 |
| `catgo_lammps_generate` | LAMMPS 输入 | Generate LAMMPS input + data | 生成 LAMMPS 输入 |
| `catgo_optimize` | ML 优化 | Optimize with MACE/CHGNet/M3GNet | ML 势函数优化 |
| `catgo_energy` | 单点能 | Single-point energy with ML potential | ML 势单点能 |

### Workflow & Analysis | 工作流与分析

| Tool | 工具 | Description | 描述 |
|------|------|-------------|------|
| `catgo_workflow` | 工作流 | Create, edit, run DAG workflows | 创建、编辑、运行 DAG 工作流 |
| `catgo_cn_coupling_network` | C-N 偶联网络 | Enumerate C-N coupling reaction paths | 枚举 C-N 偶联反应路径 |
| `catgo_catalysis_oer` | OER 分析 | Compute OER overpotential (CHE model) | 计算 OER 过电位 |
| `catgo_catalysis_free_energy` | 自由能 | Gibbs free energy: G = E + ZPE - TS | 吉布斯自由能校正 |

---

## Workflow Engine | 工作流引擎

The visual DAG workflow editor lets you chain calculation steps:

可视化 DAG 工作流编辑器，串联计算步骤：

### Available Node Types | 可用节点类型

**Calculations | 计算节点：**
- `geo_opt` — Geometry optimization | 几何优化
- `single_point` — Single-point energy | 单点能
- `cell_opt` — Cell optimization | 晶胞优化
- `md` — Molecular dynamics | 分子动力学
- `slow_growth` — Slow-growth constrained AIMD | 慢增长约束 AIMD
- `freq` — Vibrational frequencies | 振动频率
- `ts_search` — Transition state search | 过渡态搜索

**Analysis | 分析节点：**
- `dos_analysis` — Density of states | 态密度
- `md_analysis` — RDF, RMSD, MSD | 径向分布函数等
- `free_energy` — Free energy diagram | 自由能图

### Example: Electrochemical Slow-Growth Workflow | 电化学 Slow-Growth 工作流

```
structure_input → geo_opt → md (NVT equilibration) → slow_growth (ICONST constraint)
```

Tell CatBot:

```
"Create a slow-growth workflow for C-N coupling: optimize the structure,
equilibrate with NVT MD at 300K, then run slow-growth AIMD with C-N
distance constraint from 4.0 to 1.4 Å"
```

---

## HPC Integration | 超算集成

### Connect to HPC | 连接超算

1. Go to **Server** panel (right sidebar) | 打开右侧 Server 面板
2. Click **+ Connect** | 点击连接
3. Enter SSH credentials (supports key, password, OTP) | 输入 SSH 凭据
4. Browse files, submit jobs, monitor progress | 浏览文件、提交作业、监控进度

### Supported Auth Methods | 支持的认证方式

- SSH Key | SSH 密钥
- Password | 密码
- Key + OTP (e.g., KAUST Shaheen) | 密钥 + 一次性密码
- Password + OTP | 密码 + 一次性密码
- SOCKS5 Proxy | SOCKS5 代理
- Jump Host | 跳板机

### File Operations | 文件操作

- Browse remote directories | 浏览远程目录
- Open structure files directly in 3D viewer | 直接在 3D 查看器中打开结构文件
- Edit text files with Monaco editor | 用 Monaco 编辑器编辑文本文件
- Upload/download without size limits | 上传/下载无大小限制
- Integrated terminal (SSH PTY) | 集成终端

---

## Project Structure | 项目结构

```
catgo/
├── src/                    # Frontend (SvelteKit + Svelte 5)
│   └── lib/
│       ├── structure/      # 3D viewer + structure tools
│       ├── workflow/       # DAG workflow editor
│       ├── chat/           # CatBot AI assistant
│       └── api/            # Frontend API layer
├── server/                 # Backend (FastAPI + Python)
│   ├── routers/            # REST API endpoints
│   ├── utils/              # Core algorithms
│   ├── workflow/           # Workflow engine + catalysis
│   ├── mcp_tools/          # MCP tool definitions for AI agents
│   └── plugins/            # Plugin system
├── src-tauri/              # Desktop app (Rust + Tauri)
├── desktop/                # Standalone desktop frontend
├── extensions/             # Rust/WASM extensions
├── catbot-plugin/          # CatBot agent configuration
└── plugins/                # User plugins (calculator, reader, etc.)
```

---

## Development Commands | 开发命令

| Command | 命令 | Description | 描述 |
|---------|------|-------------|------|
| `pnpm dev` | 前端开发 | Web frontend dev server (port 3000) | Web 前端开发服务器 |
| `pnpm desktop:dev` | 桌面前端 | Desktop frontend (port 3100) | 桌面前端开发服务器 |
| `pnpm desktop:serve` | 完整启动 | Frontend + Python backend together | 前端 + Python 后端一起启动 |
| `pnpm tauri:dev` | Tauri 应用 | Full Tauri desktop app | 完整 Tauri 桌面应用 |
| `pnpm check` | 类型检查 | Svelte / TypeScript check | Svelte / TypeScript 类型检查 |

---

## Learning with AI | 用 AI 学习 CatGO

The best way to learn CatGO is to interact with CatBot directly. Here's a guided learning path:

学习 CatGO 的最佳方式是直接和 CatBot 对话。以下是学习路径：

### Level 1: Basic Operations | 基础操作

```
"Fetch silicon from Materials Project"                    # Load a structure | 加载结构
"Show me the structure info"                              # Inspect | 查看信息
"Create a 2x2x2 supercell"                               # Supercell | 超胞
"Cut a (111) slab with 3 layers and 15 Å vacuum"         # Surface | 切面
"Place CO on a top site"                                  # Adsorption | 吸附
```

### Level 2: DFT Setup | DFT 设置

```
"Generate VASP input for relaxation with PBE"             # VASP input | VASP 输入
"Generate QE input for SCF calculation"                    # QE input | QE 输入
"What VASP presets are available?"                         # Presets | 预设参数
```

### Level 3: Workflows | 工作流

```
"Create a workflow with geo_opt followed by single_point" # Simple chain | 简单链
"Add a DOS analysis node after the single point"          # Analysis | 分析
"Validate and show me the workflow"                       # Validate | 验证
```

### Level 4: Advanced Research | 高级研究

```
"List all C-N coupling paths for CO and NH2"              # Reaction network | 反应网络
"Place CO and NH2 on Cu surface for coupling study"       # Dual adsorbate | 双吸附物
"Create a slow-growth workflow with ICONST constraint"    # Slow-growth AIMD
"Add a water layer and place K+ near the adsorbate"       # Electrochemistry | 电化学
```

---

## License | 许可证

MIT License. See [LICENSE](license) for details.

MIT 许可证。详见 [LICENSE](license)。
