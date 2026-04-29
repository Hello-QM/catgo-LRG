# CatGo 前端功能地图（完整版）

**日期:** 2026-03-18
**目的:** 在做任何前端修改之前，充分了解已有功能，避免重复实现或覆盖现有逻辑。

---

## 一、桌面应用布局（desktop/）

### App.svelte — 主框架
- **标签页系统:** 多标签，每个标签可以是 `structure` 或 `workflow` 类型
- **面板布局:** 每个标签支持 1/2/3/4 面板分屏（LayoutType）
- **每个面板可以包含:** 结构查看器、轨迹查看器、Cube 文件、工作流编辑器
- **Modal 系统:** 插件管理器（PluginManagerUI）

### Sidebar.svelte — 侧栏
- **三个数据源标签页:**
  - `catgo` (LocalDB) — 项目/工作流/结果树
  - HPC 文件浏览器 — 远程 SSH 文件树
  - `localdb` — 本地文件系统浏览
- **项目管理:** 创建/删除/重命名项目，拖拽工作流到项目
- **结果浏览:** 从 ASE DB 中查看已保存的结构和能量
- **HPC 会话管理:** 显示已连接的 HPC 集群，文件上传/下载
- **文件操作:** 重命名、复制、移动、删除（远程和本地）
- **数据库切换:** 可切换不同的 .db 文件

### WorkflowView.svelte — 工作流视图
- 包装 WorkflowEditor，处理标签页集成

---

## 二、结构查看器（src/lib/structure/）

### Structure.svelte — 主组件（3500+ 行）
- **3D 渲染:** Three.js WebGL，原子/键/等值面
- **工具栏:** StructureToolbar（选择/移动/旋转/铅笔模式/截图）

### 构建工具（BuildPane 内）
| 工具 | 组件 | 功能 |
|------|------|------|
| 切面/slab | MillerSlabCutterPane | Miller 指数切面，层数/真空层可调，实时预览 |
| 掺杂 | DopingPane + DopingPTPanel | 元素替换，支持多位点枚举 |
| 吸附物 | AdsorbatePlacementPane + AdsorptionSitePane | Alpha Shape 找位点，放置分子 |
| 水层 | WaterLayerPane | 指定 z 范围填充水分子 |
| 钝化 | PseudoHydrogenPane | 悬挂键加伪氢 |
| 纳米管 | NanotubePane | 碳纳米管/BN 纳米管构建 |
| 异质结 | HeterostructurePane | 晶格匹配 + 堆叠 |
| 超胞 | 直接在 Structure 中处理 | 2x2x1 等 |
| 晶格 | LatticePane | 手动编辑晶格参数 |
| 路径 | PathwayBuilderPane | NEB 路径端点构建 |
| Moiré | MoirePane | 扭转角异质结 |

### 导入/导出（IOPane）
| 操作 | 说明 |
|------|------|
| Open File | 本地文件打开 (.cif, .poscar, .xyz, .json, .cube, .pdb) |
| Paste | 粘贴结构文本 |
| Search Database | **OPTIMADE 搜索**（Materials Project, Alexandria, MC3D, OMDB, 2DMatpedia, PubChem）|
| Export | **7 种 DFT 输入格式:** VASP, ORCA, CP2K, Quantum ESPRESSO, LAMMPS, Gaussian, ABACUS |

### 分析工具
| 工具 | 组件 | 说明 |
|------|------|------|
| DOS | DosAnalysisPane + DosPlot | 态密度，支持 PDOS + d-band center |
| Band | BandAnalysisPane + BandPlot | 能带结构，支持 Fat bands |
| COHP | CohpAnalysisPane + CohpPlot | 化学键分析 |
| Charge | ChargeAnalysisPane | Bader/DDEC6 电荷分析 |
| Freq | FreqAnalysisPane | 振动频率 + 振动模式动画 |
| MD | MdAnalysisPane + 6 个子面板 | RDF, RMSD, 密度, 氢键, 聚类, 角度分析 |
| 对称性 | StructureInfoPane | 空间群, 点群 |
| Cube | CubePanel + CubeIsosurface | 电荷密度/ELF 等值面渲染 |
| Optimization | OptimizationPane | 本地 ASE/CHGNet 优化 |

### 终端
- TerminalPanel — 嵌入式终端（Tauri PTY 或 WebSocket PTY）
- 支持中文 IME 输入（已修复）

---

## 三、工作流编辑器（src/lib/workflow/）

### WorkflowEditor.svelte — 主组件
- **SVG DAG 编辑器:** 拖拽创建节点、连接边
- **实时状态:** WebSocket 监听 running/completed/failed
- **工具栏按钮:** Run, Pause, Resume, Save
- **进度显示:** completed/total 计数
- **快捷键:** 节点选择、删除

### 节点定义系统（node-defs/）

**6 个分类 | 31 个节点类型:**

| 分类 | 节点类型 | 说明 |
|------|---------|------|
| **Input** | `structure_input` | 结构输入 |
| **Calculation** | `geo_opt` | 几何优化（VASP/CP2K/ORCA/xTB/MLP/Sella/LAMMPS，通过 software 参数切换） |
| | `single_point` | 单点能（VASP/CP2K/ORCA/xTB） |
| | `cell_opt` | 晶胞优化（VASP/CP2K） |
| | `md` | 分子动力学（VASP/CP2K/LAMMPS/MLP） |
| | `freq` | 频率分析（VASP/CP2K/ORCA） |
| | `ts_search` | 过渡态搜索（Sella/ORCA NEB） |
| | `irc` | 内禀反应坐标（ORCA） |
| | `uvvis` | UV-Vis 光谱（ORCA TD-DFT） |
| **Tools** | `slab_gen` | 表面切割 |
| | `doping_gen` | 掺杂枚举 |
| | `adsorbate_place` | 吸附物放置 |
| | `polymer_build` | 聚合物构建 |
| | `polymer_crosslink` | 交联 |
| | `reference_mol` | 参考分子 |
| | `polymer_md` | 聚合物 MD |
| | `glass_transition` | 玻璃化转变温度 |
| | `polymer_deform` | 聚合物变形 |
| **Analysis** | `dos_analysis` | DOS 后处理 (**含 d-band center 选项**) |
| | `cohp_analysis` | COHP 分析 |
| | `md_analysis` | MD 轨迹分析 |
| | `convergence_check` | 收敛检查 |
| | `energy_compare` | 能量对比 |
| | `charge_analysis` | 电荷分析 |
| | `electronic` | 电子结构 |
| | `free_energy` | **自由能图（含温度、反应路径、外加电位参数）** |
| | `her_analysis` | HER 选择性分析 |
| | `analysis` | 通用分析 (**含 d-band center 选项**) |
| | `export_data` | 数据导出 |
| **Logic** | `condition` | 条件分支 |
| | `loop` | 循环 |
| | `merge` | 合并 |

### 已有 INCAR 预设（写在 node-defs 的 default 字段里）

| 计算类型 | 关键默认值 |
|---------|-----------|
| geo_opt | ISIF=2, NSW=200, EDIFFG=-0.02, IBRION=2 |
| cell_opt | ISIF=3, NSW=200, EDIFFG=-0.01 |
| md | IBRION=0, POTIM=1.0, NSW=5000, TEBEG=300, SMASS=0 |
| freq | IBRION=5, NFREE=2, POTIM=0.015 |
| 公共 | EDIFF=1e-5, ISMEAR=0, ISPIN=2, PREC=Accurate |

### 参数编辑
- **NodeConfigPanel.svelte** — 动态表单渲染
  - 支持: select, number, boolean, string, text, periodic(元素选择器), slider
  - 支持 `show_if` 条件显示（如 software=vasp 时才显示 INCAR 参数）
  - 支持参数分组（group: INCAR, Kpoints, Parallelization 等）

### 运行配置
- **RunConfigDialog.svelte** — 运行前的对话框
  - HPC 会话选择
  - 工作目录设置
  - 轮询间隔
  - 作业参数模板
  - Custodian 开关 + 最大错误数

### 结果显示（NodeStatusPanel.svelte）

**已支持的结果类型:**
| 结果类型 | 显示内容 |
|---------|---------|
| VASP geo_opt | 收敛曲线（ConvergencePlot）、能量、最大力、步数、EDIFFG 目标对比 |
| VASP static | 能量(Eh/eV)、磁矩、电子步数 |
| VASP freq | GibbsCalculator（ZPE + 热力学校正）、振动模式列表+动画 |
| ORCA 全类型 | 能量(Eh)、NEB 势垒、IRC 端点、UV-Vis 跃迁表、收敛曲线 |
| 通用 | 远程文件树（StepFileTree）、错误信息显示 |
| **失败节点** | **"Rerun from here" 按钮（Phase 1 Prompt 5 新增）** |

**未显示的结果类型（Phase 1+2 新增但无 UI）:**
| 节点 | 后端有数据 | 前端不显示 |
|------|-----------|-----------|
| free_energy | G, ZPE, TS, temperature | ❌ 无 section |
| energy_compare | 排名表, relative_eV | ❌ 无 section |
| pick_best | 最优结构 ID + 能量 | ❌ 节点不在前端 NODE_DEFINITIONS |
| batch_adsorbate_place | 放置数量 + 结构列表 | ❌ 节点不在前端 NODE_DEFINITIONS |

---

## 四、AI 聊天（src/lib/chat/）

### ChatPane.svelte
- 对话界面，支持多会话
- 支持附件（结构文件、截图）
- 工具调用结果渲染（ToolResultRenderer）

### 工具系统
- **20 个工作流工具** (workflow-tools.ts)
  - 包括: list_workflows, create_workflow, add_node, connect_nodes, run_workflow, retry_step, compute_oer, etc.
- **39 个结构工具** (structure-tools.ts)
  - 包括: add_atom, delete_atoms, replace_atom, create_supercell, cut_slab, dope_structure, find_adsorption_sites, place_adsorbate, generate_vasp_input, compute_dos, compute_dband, compute_band_structure, compute_cohp, capture_screenshot, etc.
- **工具执行器:** workflow-tool-executor.ts, structure-tool-executor.ts
- **AI 提供商:** Anthropic Claude（通过 llm-client.ts）
- **RAG 上下文:** rag.ts（文档嵌入检索）

### 分析会话
- analysis-session-store.svelte.ts — 跟踪活跃的 DOS/Band/COHP/MD 分析会话
- 支持从 CatBot 工具调用触发分析，结果持久化

---

## 五、API 层（src/lib/api/）

| 文件 | 功能 |
|------|------|
| config.ts | API_BASE 配置（自动检测 Tauri/desktop/web 模式） |
| workflow.ts | 工作流 CRUD + 运行/暂停/恢复 + WebSocket 监听 |
| hpc.ts | SSH 连接/断开、文件操作、作业查询 |
| optimade.ts | OPTIMADE 数据库搜索（28 个 provider） |
| materials-project.ts | Materials Project API（需要 API key） |
| pubchem.ts | PubChem 分子搜索 |
| dos.ts / bands.ts / cohp.ts | 电子结构分析 API |
| md.ts | MD 轨迹分析 API |
| compute.ts | 结构优化、对称性分析 |
| build.ts | 结构构建操作（超胞、掺杂等） |
| adsorbate.ts | 吸附位点查找 + 放置 |
| project.ts | 项目管理 + ASE DB 操作 |
| db-wasm.ts / db-local.ts | WASM SQLite 本地数据库 |
| trajectory-edit.ts | 轨迹帧编辑 |

---

## 六、其他模块

| 模块 | 功能 |
|------|------|
| src/lib/electronic/ | DOS/Band/COHP/Charge/Freq 分析面板（15 个文件） |
| src/lib/md/ | MD 分析面板（RDF/RMSD/密度/氢键/聚类/动力学，10 个文件） |
| src/lib/trajectory/ | 轨迹解析/播放/导出 |
| src/lib/gesture/ | 手势识别 + 语音控制（实验性） |
| src/lib/plugins/ | 插件加载器 + SDK + UI |
| src/lib/symmetry/ | 空间群/点群分析 |
| src/lib/composition/ | 化学式解析/格式化 |
| src/lib/io/ | 文件导入调度器（CIF/POSCAR/XYZ/JSON/PDB/Cube） |

---

## 七、关键发现（影响 Phase 1+2 前端集成）

### 已有但被 Phase 1+2 忽略的功能

1. **INCAR 预设已内置在 node-defs 里** — 每个计算类型的 `default_params` 和 `param_schema` 已经定义了合理的 INCAR 默认值。后端 `presets/vasp.py` 是**重复实现**。

2. **`free_energy` 节点定义已存在** — 前端已有完整的 `free_energy` 节点（含 temperature, pathway, potential 参数），但后端的 `free_energy` analysis handler 和前端定义的参数 schema **不一致**。

3. **d-band center 已有两个入口:**
   - `dos_analysis` 节点有 `d_band: true` 参数
   - `analysis` 节点有 `d_band_center` 选项
   - CatBot `compute_dband` 工具也支持
   - 但 Phase 2 的 `descriptors.py` 是另一个独立实现

4. **`energy_compare` 节点定义已存在** — 前端定义了 adsorption_energy/surface_energy/formation_energy/relative_stability 四种度量，但后端 handler 的实现和前端定义的参数**不匹配**。

5. **`her_analysis` 节点定义已存在** — 前端有定义但后端 handler 是空的。

6. **GibbsCalculator 组件已存在** — 在 NodeStatusPanel 中为 VASP freq 节点提供 ZPE + 热力学校正计算。但它是**交互式计算器**（用户点击按钮触发），不是自动显示后端计算结果。

### 前端已有但后端未对接的节点类型

| 前端节点 | 后端 handler |
|---------|-------------|
| `uvvis` | ✅ ORCA engine |
| `her_analysis` | ❌ 空壳 |
| `condition` | ❌ 仅定义 |
| `loop` | ❌ 仅定义 |

### Phase 1+2 新增但前端未注册的节点类型

| 后端节点 | 前端 NODE_DEFINITIONS |
|---------|----------------------|
| `pick_best` | ❌ 未注册 |
| `batch_adsorbate_place` | ❌ 未注册 |

---

## 八、前端-后端对接完整性审查

> **2026-03-18 深度审查:** 逐项验证每个前端功能是否有真实的后端实现。

### 8.1 工作流节点后端实现状态

| 节点类型 | 前端定义 | 后端 Handler | 状态 | 说明 |
|---------|---------|-------------|------|------|
| **计算节点** | | | | |
| `geo_opt` | ✅ | ✅ engines/vasp,cp2k,orca,xtb,mlp | **完整** | 所有 software 后端都有 |
| `single_point` | ✅ | ✅ 同上 | **完整** | |
| `cell_opt` | ✅ | ✅ vasp,cp2k | **完整** | |
| `md` | ✅ | ✅ vasp,cp2k,lammps,mlp | **完整** | |
| `freq` | ✅ | ✅ vasp,cp2k,orca | **完整** | |
| `ts_search` | ✅ | ✅ engines/sella.py | **完整** | Sella + ORCA NEB |
| `irc` | ✅ | ✅ engines/orca.py | **完整** | ORCA IRC |
| `uvvis` | ✅ | ✅ engines/orca.py | **完整** | ORCA TD-DFT |
| **构建节点** | | | | |
| `structure_input` | ✅ | ✅ engines/local.py | **完整** | |
| `slab_gen` | ✅ | ✅ engines/local.py | **完整** | pymatgen SlabGenerator |
| `doping_gen` | ✅ | ✅ engines/local.py:181-237 | **完整** | 支持枚举 |
| `adsorbate_place` | ✅ | ✅ engines/local.py | **完整** | AdsorbateSiteFinder |
| `polymer_build` | ✅ | ❌ **无 handler** | **空壳** | 前端有定义，后端没实现 |
| `polymer_crosslink` | ✅ | ❌ **无 handler** | **空壳** | 同上 |
| `polymer_md` | ✅ | ❌ **无 handler** | **空壳** | LAMMPS 引擎有但节点分派缺失 |
| `glass_transition` | ✅ | ❌ **无 handler** | **空壳** | 同上 |
| `polymer_deform` | ✅ | ❌ **无 handler** | **空壳** | 同上 |
| `reference_mol` | ✅ | ❌ **无 handler** | **空壳** | 被路由到 HPC，但无特殊逻辑 |
| **控制流节点** | | | | |
| `condition` | ✅ | ⚠️ **TODO 占位** | **空壳** | 标记完成但不做评估 |
| `loop` | ✅ | ⚠️ **TODO 占位** | **空壳** | 标记完成但不做迭代 |
| `merge` | ✅ | ⚠️ **TODO 占位** | **空壳** | 标记完成但不做合并 |
| **分析节点** | | | | |
| `free_energy` | ✅ | ✅ analysis.py:85-94 | **完整** | gibbs_free_energy() |
| `energy_compare` | ✅ | ✅ analysis.py:271-344 | **完整** | 多父节点排名 |
| `convergence_check` | ✅ | ✅ analysis.py:216-268 | **完整** | 能量+力收敛检查 |
| `pick_best` | ❌ 前端未注册 | ✅ analysis.py:347-389 | **后端有前端无** | Phase 2 新增 |
| `dos_analysis` | ✅ | ⚠️ 仅元数据 | **半成品** | 不计算 DOS，前端需单独调 session API |
| `cohp_analysis` | ✅ | ⚠️ 仅元数据 | **半成品** | 同上，需 LOBSTER 文件 |
| `md_analysis` | ✅ | ⚠️ 仅元数据 | **半成品** | 同上，需单独调 /api/md/* |
| `charge_analysis` | ✅ | ❌ **无 handler** | **空壳** | node_sets 注册了但 handler 缺失 |
| `electronic` | ✅ | ⚠️ 路由不明 | **可能损坏** | 在 VASP_CALC_NODES 里但无特殊处理 |
| `her_analysis` | ✅ | ❌ **无 handler** | **空壳** | 落入 no-op 默认分支 |
| `analysis` (通用) | ✅ | ❌ **无 handler** | **空壳** | 落入 no-op 默认分支 |
| `export_data` | ✅ | ⚠️ 仅标记完成 | **空壳** | 不做实际导出 |
| **Phase 2 新增** | | | | |
| `batch_adsorbate_place` | ❌ 前端未注册 | ✅ engines/batch_adsorbate.py | **后端有前端无** | |

### 8.2 结构构建工具后端状态

| 前端面板 | 后端 API | 实现方式 | 状态 |
|---------|---------|---------|------|
| MillerSlabCutterPane | ✅ WASM (ferrox) + pymatgen | 前端 WASM + 后端 fallback | **完整** |
| DopingPane | ✅ `/api/build/doping` | 后端 pymatgen | **完整** |
| AdsorbatePlacementPane | ✅ `/api/adsorbate/*` | 后端 pymatgen | **完整** |
| WaterLayerPane | ✅ `/api/water-layer/*` | 后端 routers/water_layer.py | **完整** |
| PseudoHydrogenPane | ✅ `/api/pseudo-hydrogen/*` | 后端 routers/pseudo_hydrogen.py | **完整** |
| MoirePane | ✅ `/api/moire/*` | 后端 routers/moire.py | **完整** |
| NanotubePane | ✅ `/api/nanotube/*` | 后端 routers/nanotube.py | **完整** |
| HeterostructurePane | ✅ `/api/heterostructure/*` | 后端 routers/heterostructure.py | **完整** |
| PathwayBuilderPane | 无后端 | **纯前端 TypeScript** | **完整** (不需要后端) |
| OptimizationPane | 无 Python 后端 | **WASM (ferrox) + 本地 ASE** | **完整** (不需要后端) |
| DopingPTPanel | ✅ 通过 build API | 前端 UI + 后端 doping | **完整** |
| LatticePane | 无后端 | **纯前端** | **完整** |

### 8.3 分析工具后端状态

| 前端组件 | 后端 | 状态 |
|---------|------|------|
| DosAnalysisPane + DosPlot | ✅ routers/dos.py (session-based) | **完整** — 上传 H5/PROCAR，计算 PDOS/d-band |
| BandAnalysisPane + BandPlot | ✅ routers/bands.py (session-based) | **完整** — 上传 vasprun，投影能带 |
| CohpAnalysisPane + CohpPlot | ✅ routers/cohp.py (session-based) | **完整** — 上传 COHPCAR |
| FreqAnalysisPane | ✅ 后端频率解析 | **完整** |
| ChargeAnalysisPane | ✅ Bader via HPC 计算 | **完整** — 需要先跑 Bader 作业 |
| GibbsCalculator | ✅ workflow API calculate_gibbs | **完整** — 调用 catalysis/free_energy |
| MdAnalysisPane (6 子面板) | ✅ routers/md.py (10+ 端点) | **完整** — RDF/RMSD/密度/氢键/聚类/角度 |

### 8.4 工作流模板后端支持

| 模板 | 涉及的节点 | 所有节点有后端? |
|------|-----------|---------------|
| Band Structure | geo_opt → single_point → electronic | ⚠️ `electronic` 路由不明 |
| VASP Double Relax | geo_opt → geo_opt → single_point | ✅ |
| Bulk to Slabs | cell_opt → slab_gen → loop → geo_opt → ... | ⚠️ `loop` 是空壳 |
| Full Catalysis Pipeline | ... → adsorbate → geo_opt → freq → free_energy | ✅ (除 loop) |
| MLP Pre-screen + DFT | mlp → condition → vasp | ⚠️ `condition` 是空壳 |

---

## 九、关键发现总结

### 空壳节点（前端有定义，后端无实现）

**高影响（阻断工作流模板使用）：**
- `condition` / `loop` / `merge` — 控制流全部是占位符，**工作流模板中的条件分支和循环不工作**
- `her_analysis` — HER 选择性分析未实现
- `charge_analysis` — handler 缺失，会报错

**中影响：**
- `polymer_build` / `polymer_crosslink` / `polymer_md` / `glass_transition` / `polymer_deform` — 聚合物模拟节点全部是空壳
- `export_data` — 不做实际导出
- `electronic` — 路由不明确

### 半成品节点（标记完成但不做计算）

- `dos_analysis` / `cohp_analysis` / `md_analysis` 工作流节点 — 只存元数据，不调用实际分析
  - **但是：** 对应的 session-based 分析 API（`/api/dos/*`, `/api/cohp/*`, `/api/md/*`）是**完整的**
  - 差距是工作流节点没有自动触发 session 分析

### Phase 1+2 重复实现

| 我做的 | 已有的 | 关系 |
|-------|-------|------|
| `presets/vasp.py` | `node-defs/calculation.ts` 的 default 字段 | **重复** — 前端已有 INCAR 预设 |
| `catalysis/descriptors.py` d-band | `DosAnalysisPane` 的 `d_band: true` + session API `/api/dos/dband` | **重复** — DOS session 已能算 d-band |
| `catalysis/free_energy.py` gibbs | `GibbsCalculator` + `calculate_gibbs` API | **部分重复** — GibbsCalculator 是交互式的，free_energy 节点是自动的 |

### 真正有价值的 Phase 1+2 新增

| 功能 | 对已有功能的增量价值 |
|------|-------------------|
| 轮询容错 + 指数退避 (Prompt 1) | ✅ 之前没有 |
| 孤儿检测 + sacct 验证 (Prompt 2) | ✅ 之前只标记 paused |
| 状态审计日志 (Prompt 3) | ✅ 之前没有 |
| 错误分类 (Prompt 4) | ✅ 之前没有 |
| "从这里重跑" (Prompt 5) | ✅ 之前没有 |
| 参数变更检测 (Prompt 6) | ✅ 之前没有 |
| Batch Node (Prompt 7-9) | ✅ 之前没有 SLURM array |
| 催化活性计算 OER/CO2RR/NRR (Prompt 10-11) | ✅ **工作流节点级别**之前没有（GibbsCalculator 是交互式的） |
| Volcano Plot 数据 (Prompt 11) | ✅ 之前没有 |
| 数据溯源 (Prompt 12) | ✅ 之前没有 |
| not_converged 自动重跑 (Prompt 15) | ✅ 之前没有 |
| 批量吸附物放置 (Prompt 17) | ✅ 之前单个放置 |
| CP2K 错误处理 (Prompt 22) | ✅ 之前只有 VASP custodian |
| 结构来源链 (Prompt 24) | ✅ 之前没有 |

---

## 十、结论

CatGo 前端已经非常丰富 — **57+ 个结构工具面板、31 个节点类型、90+ AI 工具、8 种 DFT 输入格式、6 种分析类型**。

**最大的系统性问题不是缺功能，而是控制流节点（condition/loop/merge）是空壳。** 这意味着所有依赖条件分支或循环的工作流模板（占 14 个模板中的 ~6 个）实际上不能正常工作。

### 下一步优先级

1. **P0: 实现 condition/loop/merge 控制流** — 这是工作流模板能否使用的关键
2. **P0: 修复 charge_analysis handler 缺失** — 会导致运行时报错
3. **P1: NodeStatusPanel 添加 free_energy/energy_compare 结果显示** — 后端有数据但前端不显示
4. **P1: 注册 pick_best/batch_adsorbate_place 到前端 NODE_DEFINITIONS**
5. **P1: DiagnosticsPanel 接入桌面侧栏**
6. **P2: 新建 VolcanoPlot 组件**
7. **P2: 新建 Lineage 面包屑组件**
