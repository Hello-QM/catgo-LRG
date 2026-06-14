# CatGo 文档

**CatGo** 是一个**面向计算材料科学的 AI 驱动工作台**。它把交互式 3D 结构查看器、可视化 DAG 工作流引擎、集成 HPC 编排，以及自然语言 AI 助手（**CatBot**）整合进一个桌面应用（Tauri）中，并提供 VS Code 扩展以支持编辑器内工作流。查看器可以处理晶体、分子和表面；工作流引擎可以生成 DFT/MD/ML 输入，在远程集群上提交和监控任务，并通过能带图、相图、轨迹播放器等工具完成后处理。

## 主要功能

- **3D 结构查看器** - 交互式查看晶体、分子和表面，支持化学键、晶格和周期镜像原子
- **多格式 I/O** - 解析和导出 CIF、POSCAR、XYZ、EXTXYZ、HDF5、CUBE 以及压缩归档
- **表面工程** - 根据 Miller 指数生成 slab，添加真空层，寻找吸附位点
- **对称性分析** - 通过 Spglib/Moyo（WASM）检测空间群和 Wyckoff 位置
- **结构优化** - 使用 EMT、xTB、MACE、CHGNet、M3GNet 等计算器进行几何弛豫
- **光谱分析** - XRD 图谱、径向分布函数、能带结构、态密度
- **相图** - 二元、三元和四元凸包稳定性分析
- **轨迹播放** - 支持大文件流式加载的 MD 轨迹动画
- **密度可视化** - CUBE 文件等值面和 2D 切片平面
- **数据库集成** - 从 OPTIMADE、Materials Project 和 PubChem 搜索结构
- **跨平台** - Web 应用、Tauri 桌面应用、VS Code 扩展、Jupyter widget

## 架构概览

```
CatGo
├── src/lib/                  # Svelte 5 component library (88 components)
│   ├── structure/            # 3D structure viewer (largest module)
│   ├── bands/                # Band structure & DOS plots
│   ├── brillouin/            # Brillouin zone visualization
│   ├── composition/          # Composition charts
│   ├── coordination/         # Coordination analysis
│   ├── cube/                 # CUBE file density viewer
│   ├── element/              # Element database (118 elements)
│   ├── periodic-table/       # Interactive periodic table
│   ├── phase-diagram/        # Phase diagram components
│   ├── plot/                 # General plotting (scatter, bar, histogram)
│   ├── rdf/                  # Radial distribution function
│   ├── trajectory/           # MD trajectory player
│   ├── xrd/                  # X-ray diffraction patterns
│   ├── api/                  # API clients (OPTIMADE, MP, PubChem)
│   └── settings.ts           # Unified settings schema
├── extensions/rust/          # Rust library compiled to WASM
│   └── src/wasm.rs           # 65+ WASM-exposed functions
├── server/                   # Python FastAPI computation backend
│   └── routers/              # Optimization, database, spectroscopy routes
├── src-tauri/                # Tauri desktop app shell
└── extensions/vscode/        # VSCode extension
```

### 技术栈

| 层级 | 技术 |
|-------|-----------|
| UI 组件 | Svelte 5（runes: `$state`, `$derived`, `$effect`） |
| 框架 | SvelteKit with static adapter |
| 3D 渲染 | Three.js via Threlte |
| 2D 图表 | D3.js |
| 重计算 | Rust compiled to WebAssembly（ferrox-wasm） |
| 对称性 | Spglib / Moyo（WASM） |
| HDF5 文件 | h5wasm |
| 桌面应用 | Tauri 2.0 |
| 计算服务器 | Python FastAPI + ASE |
| 类型安全 | TypeScript（strict mode） |

## 模块

### 核心

| 模块 | 说明 |
|--------|-------------|
| [结构查看器](/zh/modules/core/structure-viewer) | 原子、化学键和晶格的 3D 交互式可视化 |
| [文件 I/O](/zh/modules/core/file-io) | 解析和导出晶体/分子结构文件 |
| [晶格与晶胞](/zh/modules/core/lattice-cell) | 晶格参数、坐标转换和晶胞操作 |
| [键合](/zh/modules/core/bonding) | 键检测、键编辑和配位分析 |

### 晶体学

| 模块 | 说明 |
|--------|-------------|
| [表面与 Slab](/zh/modules/crystallography/surfaces-slabs) | Miller 指数 slab 生成、真空层、吸附位点 |
| [对称性](/zh/modules/crystallography/symmetry) | 空间群检测、Wyckoff 位置、Bravais 晶格 |
| [超胞](/zh/modules/crystallography/supercells) | 周期晶胞扩展和变换 |

### 动力学与优化

| 模块 | 说明 |
|--------|-------------|
| [轨迹](/zh/modules/dynamics/trajectories) | MD 轨迹播放、帧索引和流式加载 |
| [优化](/zh/modules/dynamics/optimization) | 使用多种计算器进行结构弛豫 |

### 分析与光谱

| 模块 | 说明 |
|--------|-------------|
| [光谱分析](/zh/modules/analysis/spectroscopy) | XRD、RDF、能带结构、态密度 |
| [相图](/zh/modules/analysis/phase-diagrams) | 热力学稳定性和凸包 |
| [组成](/zh/modules/analysis/composition) | 化学式处理和组成图表 |
| [周期表](/zh/modules/analysis/periodic-table) | 带属性数据的交互式元素浏览器 |

### 集成

| 模块 | 说明 |
|--------|-------------|
| [密度可视化](/zh/modules/integrations/density-visualization) | CUBE 文件等值面和切片平面 |
| [数据库集成](/zh/modules/integrations/database-integration) | OPTIMADE、Materials Project、PubChem 搜索 |
| [设置](/zh/modules/core/settings) | 跨平台的 40+ 个可配置属性 |

## 部署目标

| 目标 | 说明 |
|--------|-------------|
| **Web App** | SvelteKit 静态站点，可在现代浏览器中运行 |
| **Desktop App** | Tauri 2.0，面向 macOS、Windows、Linux 的原生应用，支持文件系统访问 |
| **VSCode Extension** | 嵌入文本编辑器中的查看器 |
| **Jupyter / Marimo** | 面向计算 notebook 的 widget |

## 教程

常见工作流的分步指南：

| 教程 | 说明 |
|----------|-------------|
| [快速上手](/zh/tutorials/basics/getting-started) | 加载、查看并导出第一个结构 |
| [构建 Slab](/zh/tutorials/structures/building-slabs) | 根据 Miller 指数生成表面 slab |
| [结构优化](/zh/tutorials/structures/optimization) | 使用 UFF、xTB、MACE 等弛豫结构 |
| [数据库搜索](/zh/tutorials/structures/database-search) | 从 OPTIMADE、Materials Project、PubChem 查找结构 |
| [轨迹播放](/zh/tutorials/visualization/trajectories) | 加载和分析 MD 轨迹 |
| [密度可视化](/zh/tutorials/visualization/density-viz) | CUBE 文件等值面和切片平面 |

## 快速链接

- [安装](/zh/guide/installation)
- [教程](/zh/tutorials/basics/getting-started)
- [图库](/zh/guide/gallery)
- [技巧与提示](/zh/guide/tips-and-tricks)
- [FAQ](/zh/reference/faq)
- [更新日志](/zh/reference/changelog)
- [贡献指南](/zh/developer/contributing)
- [开发指南](/zh/developer/development-guide)
- [桌面构建指南](/zh/developer/desktop-build)
- [GitHub 仓库](https://github.com/Hello-QM/catgo-LRG)
