# 工作流引擎

工作流引擎是 CatGo 用来构建和执行多步计算流水线的系统。它提供可视化节点编辑器、REST/WebSocket 监控界面、异步后端执行，以及持久化的 workflow/project 状态。

## 创建工作流的两条路径

在 CatGo 中有两种方式创建工作流：

- **可视化编辑器** - 从节点面板拖入节点、连接边、配置参数并运行。源码：`src/lib/workflow/`。
- **CatBot（自然语言）** - 用自然语言描述计算任务，让助手构建图。它由两层处理：
  - 前端会话循环中的应用内聊天工具（`src/lib/chat/workflow-tools.ts`）
  - 面向 SDK agent 工作流的 MCP `catgo_workflow` 工具（`server/mcp_tools/server.py`）

两套 AI 层共享同一套节点 schema 和 CRUD 端点，但有几个行为差异需要注意：

- MCP 的 `create` 路径会自动添加 `structure_input` 节点，保证 agent 总有起点。
- MCP 的 `run` 路径会在调用时立即开始执行，不经过 UI 确认。这是为了支持无人值守的 agent 运行；应用内聊天路径则使用 CatBot 的 PermissionCard。

> **连接 handle 很重要。** 连线时请命名 source/destination handle（例如 `out-0`、`in-1`）。省略 handle 会回退到通用 `structure` 连接，这只适合简单的单结构链。对于有多个输出的节点（例如弛豫后结构 + WAVECAR + DOS），必须显式指定 handle。

## 权威来源

本页从“如何组合计算流水线”的角度描述工作流引擎结构和节点目录。最新节点名、参数 schema 和 handle alias 以源码为准：

- **节点定义** - `src/lib/workflow/node-definitions.ts`
- **前端聊天工作流工具** - `src/lib/chat/workflow-tool-executor.ts`
- **MCP 工作流工具表面** - `server/mcp_tools/server.py`
- **已知问题与编排注意事项** - `WORKFLOW_BUGS.md`

## 架构

```
┌──────────────────────────────────┐
│ Workflow Editor (Svelte 5)       │ Visual graph builder
│ Node palette, edge connections,  │ Templates, undo/redo
│ parameter forms, run config      │
├──────────────────────────────────┤
│ Workflow API (FastAPI)           │ REST + WebSocket
│ CRUD, execution control,         │ Real-time monitoring
│ results, templates               │
├──────────────────────────────────┤
│ Workflow Engine (async Python)   │ Topological execution
│ Job submission, polling,         │ Custodian error handling
│ result extraction, ASE DB        │
├──────────────────────────────────┤
│ HPC Cluster (SSH)                │ VASP, MLP, Bader
│ SLURM / PBS scheduler            │ Remote file I/O
└──────────────────────────────────┘
```

### 执行模型

1. **拓扑排序** - 节点会根据依赖关系排序成多个 layer
2. **逐层执行** - 同一层中的节点并行运行；当前层全部完成后才启动下一层
3. **路由** - 每个节点会被路由到对应执行器：
   - **HPC**：VASP 计算、MLP 计算、Bader 分析
   - **Local**：结构变换、分析、逻辑节点
4. **结果传递** - 输出结构和能量会通过边流向下游

### 状态机

```
Workflow:  draft -> running -> (paused) -> completed / failed
Step:      pending -> queued -> running -> completed / failed / skipped
```

---

## 节点参考

### 输入节点

#### Structure Input

为工作流提供起始结构。

| 参数 | 类型 | 说明 |
|-----------|------|-------------|
| source | select | 文件上传、Materials Project、OPTIMADE、ASE DB 或 editor |
| structure | text | POSCAR 格式结构数据 |

---

### DFT 计算节点

所有 DFT 节点都会通过 SSH 在 HPC 集群上运行。它们生成 VASP 输入文件（INCAR、POSCAR、KPOINTS），提交作业，轮询完成状态，并提取结果。

#### VASP Relax

使用 conjugate gradient、quasi-Newton 或 FIRE 进行几何优化。

| 参数 | 默认值 | 范围 | 说明 |
|-----------|---------|-------|-------------|
| ENCUT | 520 | 200-800 eV | 平面波截断能 |
| EDIFF | 1e-5 | 1e-4 to 1e-7 | 电子收敛标准 |
| EDIFFG | -0.02 | - | 离子收敛标准（负值表示力，单位 eV/A） |
| ISIF | 3 | 2/3/4/7 | 2 = 固定晶胞，3 = 全优化，4 = 固定体积，7 = 只优化体积 |
| NSW | 200 | 1-1000 | 最大离子步 |
| IBRION | 2 | 1/2/3 | 1 = Quasi-Newton，2 = CG，3 = FIRE（需要 VTST） |
| KPOINTS | 4x4x4 | - | k 点网格 |
| double_relax | false | - | 运行两次（atomate2 DoubleRelaxMaker 模式） |
| NCORE | 4 | 1-24 | 每个 orbital band 的核心数 |
| LWAVE | false | - | 写出 WAVECAR |
| LCHARG | true | - | 写出 CHGCAR |
| custom_incar | - | - | 额外 INCAR 标签（自由文本） |

**输出：** 弛豫结构（CONTCAR）、总能量、力、应力张量。

#### VASP Static

在固定几何上进行单点能计算。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| ENCUT | 520 | 平面波截断 |
| EDIFF | 1e-6 | 更严格的电子收敛 |
| ISMEAR | -5 | 带 Blochl 修正的四面体方法 |
| LORBIT | 11 | 将 DOS 投影到原子 |
| NEDOS | 3001 | DOS 网格点 |
| KPOINTS | 6x6x6 | 用于准确 DOS 的更密 k 网格 |

**输出：** 能量、DOS 数据、电荷密度。

#### VASP MD

从头算分子动力学。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| TEBEG | 300 | 起始温度（K） |
| NSW | 5000 | MD 步数 |
| POTIM | 1.0 | 时间步长（fs） |
| SMASS | -1 | Thermostat：-1 = NVE，0 = NVT scaled，3 = Nose-Hoover |
| ENCUT | 400 | MD 可使用较低截断 |

**输出：** 轨迹、能量随时间变化、温度曲线。

#### 电子结构分析

电子结构性质后处理。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| analysis | dos | 类型：dos、bader、cohp |
| NEDOS | 3001 | DOS 能量网格点 |
| LORBIT | 11 | 轨道投影级别 |
| ISMEAR | -5 | 用于准确 DOS 的四面体方法 |

**输出：** DOS 数据、Bader 电荷或 COHP 键合分析，取决于 `analysis` 类型。

#### Frequency

通过有限差分计算振动频率。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| IBRION | 5 | 5 = 有限差分，6 = 所有方向 |
| NFREE | 2 | 每个方向 2 或 4 个位移 |
| POTIM | 0.015 | 位移步长（A） |
| EDIFF | 1e-7 | 用于力的严格电子收敛 |

**输出：** 频率（cm-1）、零点能（ZPE）、IR 强度。

---

### ML Potential 节点

ML potential 节点在 HPC 上运行，但通常比 DFT 快得多，适合预筛选、预弛豫或长时间尺度动力学。

#### MLP Relax

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| model | MACE-MP | ML potential：MACE-MP、CHGNet、M3GNet |
| fmax | 0.01 | 力收敛标准（eV/A） |

**输出：** 弛豫结构、能量。

#### MLP MD

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| model | MACE-MP | 机器学习势模型 |
| temperature | 300 | 温度（K） |
| steps | 10000 | MD 步数 |
| timestep | 1.0 | 时间步长（fs） |

**输出：** 轨迹、能量时间序列。

---

### 表面催化节点（NRR）

面向氮还原反应研究的专用节点。

#### Bulk Optimization

使用高密 k 网格弛豫体相晶体。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| KPOINTS | 9x9x9 | 高密 k 网格 |
| ISIF | 3 | 晶胞 + 离子全弛豫 |
| ENCUT | 520 | 标准截断 |

#### Slab Generation

从体相晶体切出表面 slab（本地运行）。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| miller_h, miller_k, miller_l | 1, 1, 1 | Miller 指数 |
| layers | 4 | 原子层数 |
| vacuum | 15.0 | 真空层厚度（A） |
| supercell_a, supercell_b | 2, 2 | 面内超胞 |

#### Slab Relaxation

带底层冻结和偶极修正的表面弛豫。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| ISIF | 2 | 固定晶胞形状，只弛豫离子 |
| freeze_layers | 2 | 要冻结的底层层数 |
| LDIPOL | true | 用于非对称 slab 的偶极修正 |

#### 吸附物放置

把分子放置到表面吸附位点上（本地运行）。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| adsorbate | N2 | 要放置的分子（*N2、*NH3、*H 等） |
| site | ontop | 位点类型：ontop、bridge、fcc、hcp |
| orientation | end-on | 分子取向：end-on、side-on |

#### Reference Molecule

为热力学参考进行气相分子计算。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| molecule | N2 | 参考分子（N2、H2、NH3） |
| box_size | 20 | 立方盒尺寸（A） |
| KPOINTS | 1x1x1 | 只使用 Gamma 点 |

#### 自由能图

计算反应路径上的反应自由能。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| pathway | distal | 反应机理：distal、alternating |
| potential | -0.1 | 外加电势（V vs. RHE） |
| temperature | 298.15 | 温度（K） |

**公式：** `DG = DE + DZPE - TDS + neU`

#### HER Analysis

评估析氢选择性。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| threshold | 0.2 | 用于 NRR 选择性的 DG(*H) 阈值（eV） |

---

### 结构变换节点

所有变换节点都在服务器本地运行。它们会修改输入结构，并把结果传给下游。

#### 超胞生成

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| scaling | 2x2x2 | 超胞扩展倍数 |

#### Defect Generation

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| defect_type | vacancy | 类型：vacancy、substitution、interstitial |
| site_index | 0 | 缺陷位点的原子索引 |
| substitute | - | 替换元素（用于 substitution） |

当存在多个可能缺陷时，会枚举对称唯一位点。

#### 应变 / 形变

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| strain_type | uniaxial | 类型：uniaxial、biaxial、hydrostatic、shear |
| magnitude | 0.02 | 应变幅度（分数） |
| scan | false | 扫描模式：生成多个应变结构 |
| scan_range | -0.05 to 0.05 | 扫描模式范围 |

#### Doping

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| dopant | - | 掺杂元素 |
| host_element | - | 要被替换的元素 |

会枚举对称唯一的替换位点。

#### Intercalation

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| intercalant | Li | 插层物种（Li、Na、K） |

#### Heterostructure

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| method | ZSL | 晶格匹配算法 |
| max_area | 200 | 最大界面面积（A^2） |
| max_strain | 0.05 | 最大允许应变 |

#### Nanotube

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| n, m | 10, 0 | 手性指数 |

#### Water Solvation

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| density | 1.0 | 水密度（g/cm^3） |
| model | TIP4P | 水模型 |

#### Passivation

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| method | pseudo-H | pseudo-hydrogen（fractional Z）或 H |

---

### 分析节点

#### DOS Analysis

从父 VASP static 计算中提取 d-band center 和投影 DOS。

#### COHP Analysis

运行 LOBSTER 进行晶体轨道 Hamilton 布居分析。

#### MD Analysis

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| analysis | all | 指标：RMSD、RDF、MSD、density profile、H-bonds |

#### Convergence Check

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| energy_threshold | 1e-4 | 能量收敛（eV/atom） |
| force_threshold | 0.05 | 最大力（eV/A） |

返回 pass 或 fail。可连接到 **Condition** 节点进行分支。

#### Energy Compare

比较多个父计算的能量，输出包含吸附能、表面能或形成能的排序表。

#### Charge Analysis

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| method | bader | Bader 或 DDEC6 电荷分析 |

在 HPC 上运行，需要 Bader 可执行文件。

#### Export

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| format | json | 输出格式：json、csv、cif、poscar |

---

### 逻辑节点

#### Condition

根据条件为工作流分支。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| criterion | energy_diff | 要检查的内容：energy_diff、max_force、convergence、n_steps |
| threshold | 0.01 | 阈值 |
| operator | < | 比较操作符 |

#### Loop

遍历集合，并对每个元素执行下游节点。

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| iterate_over | structures | 遍历对象：structures、parameters |

#### Merge

同步屏障。等待所有输入边完成后再继续。无参数。

---

## 内置模板

| 模板 | 节点数 | 说明 |
|----------|-------|-------------|
| **Band Structure** | 3 | Relax -> Static -> DOS analysis |
| **吸附筛选** | 5 | 并行 DFT + MLP 弛豫，能量比较 |
| **MLP MD Pipeline** | 4 | Structure -> MLP MD -> MD analysis -> Export |
| **Batch Surface** | 5 | Loop surfaces -> Relax -> Merge -> Analyze |
| **Defect Screening** | 6 | Supercell -> Defect gen -> Loop -> Relax -> Compare |
| **异质结构研究** | 5 | 构建界面 -> 弛豫 -> DOS + COHP |

模板只是起点，加载后可以继续添加、删除或重新配置任意节点。

---

## HPC 执行

### 作业脚本预设

| 预设 | 调度器 | 说明 |
|--------|-----------|-------------|
| Generic SLURM | SLURM | 标准 SLURM 提交脚本 |
| Generic PBS | PBS | 用于 PBS/Torque 集群 |
| Shaheen-III | SLURM | 带模块加载的 KAUST HPC |

### 资源配置

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| nodes | 1 | 计算节点数 |
| ntasks | 16 | MPI task 数 |
| cpus_per_task | 8 | 每个 task 的 OpenMP 线程数 |
| walltime | 02:00:00 | 最大作业时长 |
| partition | - | 集群 partition/queue |
| memory | - | 每节点内存 |
| base_work_dir | ~/calculations | 远程工作目录 |
| poll_interval | 30s | 作业状态轮询间隔 |

### 远程目录结构

每个 step 会在 HPC 集群上创建目录：

```
~/calculations/
├── vasp_relax_abc12345/
│   ├── INCAR
│   ├── POSCAR
│   ├── KPOINTS
│   ├── POTCAR (user-provided)
│   ├── submit.sh
│   ├── run_custodian.py
│   ├── CONTCAR (output)
│   ├── OUTCAR (output)
│   └── OSZICAR (output)
└── mlp_md_def45678/
    ├── POSCAR
    ├── run_mlp.py
    └── trajectory.xyz (output)
```

### Custodian 错误处理

Custodian 默认启用，会自动处理常见 VASP 错误：

| 错误 | 应用的修复 | 最大重试次数 |
|-------|-------------|-------------|
| ZBRENT failure | 切换 IBRION | 5 |
| EDDDAV/EDWAV | 切换到 algo=Normal/Fast | 5 |
| KPOINTS too dense | 降低网格密度 | 5 |
| Charge mixing | 调整 AMIX/BMIX | 5 |
| Walltime exceeded | 从 CONTCAR 重启 | 5 |

如果需要原始 VASP 执行过程，可在运行配置中关闭 Custodian。

---

## 工作流恢复

引擎会把所有状态持久化到 SQLite 数据库，并支持自动恢复：

1. 服务器启动时，`recover_workflows()` 会检查被中断的工作流
2. 查询 HPC 集群上的作业状态
3. 提取离线期间完成的作业结果
4. 从下一个 pending layer 恢复执行

### 持久化细节

| 数据 | 存储 |
|------|---------|
| Workflow graph | SQLite（`graph_json`） |
| Step status | SQLite（`status`、`started_at`、`completed_at`） |
| HPC job IDs | SQLite（`hpc_job_id`、`hpc_session_id`） |
| Run configuration | SQLite（`WorkflowRunConfig`） |
| DFT results | ASE database（`energy`、`forces`、`structure`） |

---

## API 参考

### Workflow CRUD

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/workflow/` | POST | 创建新工作流 |
| `/workflow/` | GET | 列出所有工作流 |
| `/workflow/{id}` | GET | 获取工作流详情 |
| `/workflow/{id}` | PUT | 更新图、名称或状态 |
| `/workflow/{id}` | DELETE | 删除工作流 |

### 执行控制

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/workflow/{id}/run` | POST | 使用 run config 启动工作流 |
| `/workflow/{id}/pause` | POST | 暂停执行 |
| `/workflow/{id}/resume` | POST | 恢复暂停的工作流 |
| `/workflow/{id}/run-status` | GET | 获取当前执行状态 |
| `/workflow/{id}/monitor` | WebSocket | 实时状态流 |

### Steps and Results

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/workflow/{id}/steps` | GET | 列出所有 step |
| `/workflow/{id}/steps/{step_id}` | PUT | 更新 step 配置 |
| `/workflow/{id}/steps/{step_id}/files` | GET | 列出输出文件 |
| `/workflow/{id}/steps/{step_id}/output/{file}` | GET | 下载输出文件 |
| `/workflow/{id}/convergence/{step_id}` | GET | OSZICAR 收敛数据 |
| `/workflow/{id}/results` | GET | 获取工作流结果 |
| `/workflow/{id}/results-enriched` | GET | 获取带化学式和体积的结果 |

### Templates

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/workflow/templates` | GET | 列出可用模板 |
| `/workflow/from-template/{id}` | POST | 从模板创建工作流 |
| `/workflow/job-script-presets` | GET | 获取作业脚本预设 |
