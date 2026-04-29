# CP2K 模块完成内容总结

## 一、Max 完成的内容（初始版本）

**提交**: `76ecefe` — `feat: add CP2K input file generation and fix charge label display`

### 1. 前端 ExportPane.svelte（+470 行）

#### 状态变量（基础版）
- `cp2k_run_type`：4 种（energy / geo_opt / cell_opt / md）
- `cp2k_functional`：5 种（PBE / BLYP / SCAN / PBE0 / B3LYP）
- `cp2k_basis_set`：6 种 MOLOPT 基组
- `cp2k_cutoff` / `cp2k_rel_cutoff`
- `cp2k_scf_eps` / `cp2k_max_scf`
- `cp2k_ot_precond`（FULL_KINETIC / FULL_ALL / FULL_SINGLE_INVERSE）
- `cp2k_outer_scf` / `cp2k_outer_max_scf` / `cp2k_outer_eps`
- `cp2k_vdw`：3 种（DFTD3(BJ) / DFTD3 / DFTD2）
- `cp2k_periodic`：3 种（XYZ / XY / NONE）
- `cp2k_charge` / `cp2k_multiplicity` / `cp2k_uks`
- `cp2k_geo_optimizer` / `cp2k_geo_max_force` / `cp2k_geo_max_iter`
- `cp2k_cell_opt_max_iter` / `cp2k_cell_opt_pressure`
- `cp2k_md_ensemble` / `cp2k_md_steps` / `cp2k_md_timestep` / `cp2k_md_temperature` / `cp2k_md_thermostat` / `cp2k_md_timecon`

#### UKS 自动逻辑（基础版）
- 奇数电子 → 强制 UKS 开 + multiplicity ≥ 2
- 无 OT/DIAG 区分

#### gen_cp2k_local()（基础版，~120 行）
- 仅 OT 方法，无 Diagonalization 支持
- 简单的 `&XC_FUNCTIONAL {functional}` 写法（不区分 GGA/meta-GGA/hybrid 的特殊语法）
- VDW 仅 DFT-D2/D3/D3(BJ)，REFERENCE_FUNCTIONAL 只区分 PBE/BLYP
- &POISSON 直接写 PERIODIC，无 POISSON_SOLVER
- 固定原子仅支持：selected / z_below 两种模式
- &MOTION PRINT 统一写法（不区分 MD/GEO_OPT）

#### generate_cp2k()（基础版）
- 纯本地生成，无 API 调用

#### UI（基础版）
- CP2K tab 按钮
- Run Type 下拉（4 种）
- Functional 下拉（5 种，无分组）
- VDW 下拉
- Basis Set 下拉（6 种，无分组）
- Cutoff 输入
- Advanced 折叠面板：rel_cutoff、scf eps、max scf、OT precond、outer scf、periodic、charge、multiplicity、UKS
- GEO_OPT 折叠：optimizer、max force、max iter
- CELL_OPT 折叠：max iter、pressure
- MD 折叠：ensemble、steps、timestep、temperature、thermostat、timecon
- Fixed Atoms 折叠：none / selected / z_below 模式

### 2. 无后端路由
Max 的版本没有创建 `server/routers/cp2k.py`，也没有注册到 `__init__.py` 和 `main.py`。

### 3. 无工作流集成
没有 CP2K 工作流节点。

---

## 二、leshenzhang 完成的内容（今日修改）

### 修改文件概览

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/lib/structure/ExportPane.svelte` | +1048 / -85 | 大幅扩展状态变量、生成逻辑、UI |
| `server/routers/cp2k.py` | +650（新文件） | 完整后端 FastAPI 路由 |
| `server/routers/__init__.py` | +2 | 注册 cp2k_router |
| `server/main.py` | +2 | 挂载 cp2k_router |
| `src/lib/workflow/node-definitions.ts` | +400 | CP2K 工作流节点定义 |
| `server/models/workflow_run.py` | +4 | CP2K 计算类型分类 |
| `server/utils/workflow_engine.py` | +423 | CP2K 工作流引擎集成 |

---

### 1. 前端 ExportPane.svelte — 新增/修改内容

#### (a) 新增状态变量（~30 个）

**SCF 方法分支**:
- `cp2k_scf_method`（OT / DIAG）— Max 只有 OT
- `cp2k_ot_minimizer`（DIIS / CG / BROYDEN）
- `cp2k_smearing` / `cp2k_smearing_method`（FERMI_DIRAC / ENERGY_WINDOW）
- `cp2k_electronic_temperature`
- `cp2k_added_mos`

**扩展的 Run Type**:
- 从 4 种 → 7 种，新增 `energy_force`、`vibrational_analysis`、`linear_response`

**扩展的 Functional**:
- 从 5 种 → 14 种，新增 revPBE、PBEsol、BP86、RPBE、TPSS、revTPSS、r2SCAN、HSE06、BHandHLYP

**扩展的 VDW**:
- 新增 DFT-D4

**扩展的 Periodic**:
- 从 3 种 → 8 种（XYZ / XY / XZ / YZ / X / Y / Z / NONE）

**K-Points**:
- `cp2k_kpoints_enabled` / `cp2k_kpoints_nx` / `ny` / `nz`

**DFT+U**:
- `cp2k_dftpu_enabled`
- `cp2k_dftpu_settings`（per-element L 和 U-J）

**固定原子增强**:
- `cp2k_fix_elements`（按元素固定）
- `cp2k_fix_indices_str`（按原子索引范围固定）

**cp2kmate 高级功能（全部新增）**:
- `cp2k_cell_rep_x/y/z`（晶胞重复）
- `cp2k_fine_grid_xc`（XC 更精细网格）
- `cp2k_print_level`（LOW / MEDIUM / HIGH）
- `cp2k_print_moments`（电偶极/磁矩）
- `cp2k_print_orbital_energies`（轨道能量）
- `cp2k_output_overlap_csr`（重叠矩阵输出）
- `cp2k_output_ks_csr`（KS 矩阵输出）
- `cp2k_epr_hyperfine`（EPR 超精细耦合）
- `cp2k_efield_enabled` / `x` / `y` / `z`（外部电场）
- `cp2k_magnetization`（per-element 初始磁化）
- `cp2k_center_coords`（坐标居中）
- `cp2k_lrigpw`（LRIGPW 代替 GPW 加速）
- `cp2k_ls_scf`（线性标度 SCF）
- `cp2k_poisson_solver`（PERIODIC / ANALYTIC / MT / WAVELET / IMPLICIT）
- `cp2k_surf_dipole`（表面偶极校正）
- `cp2k_coord_from_file` / `cp2k_coord_file_name`（外部坐标文件）

#### (b) UKS 逻辑重写

```
OT 方法 → UKS 关（OT 不支持分数占据）
DIAG + 无 smearing → UKS 关
DIAG + smearing → UKS 可切换
奇数电子 → 强制 UKS 开
设置了磁化值 → 强制 UKS 开
```

#### (c) gen_cp2k_local() 完全重写（~500 行）

按照已有的CP2K计算化学惯例重写生成逻辑：

- **任务特定默认值**：频率/线性响应任务用更紧的 EPS_SCF (1e-7) 和 EPS_DEFAULT (1e-14)；MD 用更宽松的 EPS_SCF (1e-5)
- **STRESS_TENSOR ANALYTICAL**：CELL_OPT 和 NPT MD 自动添加
- **OT 分支**：MAX_SCF 25 + OUTER_SCF、LINESEARCH 2PNT、ALGORITHM STRICT、<300 原子自动用 FULL_ALL 预条件
- **DIAG 分支**：MAX_SCF 128、BROYDEN_MIXING + NBROYDEN 8、UKS 时 ADDED_MOS 翻倍
- **SCF PRINT**：频率/MD 关闭 restart；其他 BACKUP_COPIES 0
- **LRIGPW**：额外加载 LRI_BASIS_SETS、&QS 中 METHOD LRIGPW、&KIND 中 LRI_AUX 基组
- **LS_SCF**：整个 &SCF 替换为 &LS_SCF section（PURIFICATION_METHOD TRS4）
- **DFT+U**：&DFT 中 PLUS_U_METHOD MULLIKEN，&KIND 中 per-element L 和 U-J
- **Poisson PERIODIC 强制**：同时将 &POISSON 和 &CELL 的 PERIODIC 改为 XYZ
- **XC Functional**：完整处理各个泛函族的 CP2K 语法
  - GGA：直接 `&XC_FUNCTIONAL PBE` 等
  - revPBE/PBEsol/RPBE：通过 `&PBE PARAMETRIZATION xxx` 写法
  - BP86：`&BECKE88` + `&P86C`
  - TPSS/revTPSS：`&TPSS` section
  - PBE0：`&PBE SCALE_X 0.75` + `&HF FRACTION 0.25`
  - B3LYP：`&B3LYP` + `&HF FRACTION 0.20`
  - HSE06：`&XWPBE` + `&HF` + `&INTERACTION_POTENTIAL SHORTRANGE`
  - BHandHLYP：`&BECKE88 SCALE_X 0.5` + `&HF FRACTION 0.50`
- **VDW DFT-D4**：新增支持
- **&VIBRATIONAL_ANALYSIS**：独立的顶层 section（DX、INTENSITIES、THERMOCHEMISTRY）
- **表面偶极校正**：SURFACE_DIPOLE_CORRECTION + SURF_DIP_DIR
- **外部电场**：&EFIELD section
- **坐标居中**：&TOPOLOGY > &CENTER_COORDINATES（频率分析时禁用）
- **晶胞重复**：MULTIPLE_UNIT_CELL 在 &CELL 和 &TOPOLOGY 中
- **外部坐标文件**：&TOPOLOGY 中 COORD_FILE_NAME
- **per-element 磁化**：&KIND 中 MAGNETIZATION
- **FORCE_EVAL PRINT**：energy_force 输出力、cell_opt 输出应力张量

#### (d) generate_cp2k() 改为 async

- 先尝试调用后端 API `${API_BASE}/cp2k/input`
- 失败时 fallback 到本地 `gen_cp2k_local()`

#### (e) UI 完全重写

- **预设按钮**：Quick / Accurate / Surface / Metal / MD / Hybrid
- **Run Type**：7 种（删除了 BAND/NEB）
- **Functional 下拉**：用 `<optgroup>` 分 GGA / meta-GGA / Hybrid 三组
- **Basis Set 下拉**：用 `<optgroup>` 分 MOLOPT-SR / MOLOPT / ccGRB 三组
- **SCF Method 折叠**：
  - OT：预条件器 + minimizer 说明
  - DIAG：added_mos + smearing 开关 + 温度
- **Advanced 折叠**：rel_cutoff、SCF eps、max_scf、outer_scf、全部 periodic 选项、charge、multiplicity、UKS（条件性禁用）
- **K-Points 折叠**：Monkhorst-Pack nx/ny/nz
- **DFT+U 折叠**：per-element L 和 U-J 输入
- **GeoOpt/CellOpt/MD 参数折叠**
- **Fixed Atoms 折叠**：元素多选 + 原子索引范围输入
- **Other Settings 折叠**：
  - Print Level / 晶胞重复 / Fine Grid XC
  - 电偶极矩 / 轨道能量 / 坐标居中
  - LRIGPW / LS_SCF
  - 重叠矩阵输出 / KS 矩阵输出 / EPR
  - Poisson Solver / 表面偶极校正
  - per-element 磁化
  - 外部电场 (x, y, z)
  - 外部坐标文件

---

### 2. 后端 server/routers/cp2k.py（新文件，~650 行）

#### Pydantic 模型
- `DFTPlusUElement`：per-element DFT+U（L, U-J）
- `CP2KInputRequest`：50+ 字段，完整对应前端所有选项
  - 核心参数：structure, prefix, run_type, functional, basis_set, cutoff, rel_cutoff
  - SCF 方法：scf_method, ot_preconditioner, ot_minimizer, smearing, electronic_temperature, added_mos
  - 高级参数：kpoints, dftpu, fixed_indices/elements/z_below
  - cp2kmate 功能：lrigpw, ls_scf, poisson_solver, surf_dipole, efield, magnetization, center_coords, cell_rep, fine_grid_xc, print 选项, coord_from_file
- `CP2KInputResponse`：input_file, elements, n_atoms, message

#### 生成逻辑 generate_cp2k_input()
与前端 gen_cp2k_local() 完全对齐：
- 任务特定 EPS_SCF/EPS_DEFAULT
- OT/DIAG 分支 + 正确默认值
- 全部 14 种泛函的正确 CP2K 语法
- VDW DFT-D2/D3/D3(BJ)/D4
- LRIGPW / LS_SCF / DFT+U / K-Points
- STRESS_TENSOR / 表面偶极 / 电场
- &VIBRATIONAL_ANALYSIS 顶层 section
- SCF PRINT 逻辑（频率/MD vs 其他）
- &TOPOLOGY（居中、坐标文件、晶胞重复）

#### API 端点
- `POST /api/cp2k/input` — 生成输入文件
- `GET /api/cp2k/templates` — 6 种预设模板（energy / geo_opt / metal / md_nvt / hybrid_pbe0 / hybrid_hse06）

#### 注册
- `server/routers/__init__.py`：添加 `cp2k_router`
- `server/main.py`：挂载 `cp2k_router` 到 `/api`

---

### 3. 工作流集成（全部新增）

#### node-definitions.ts（+400 行）
5 种 CP2K 工作流节点，归类在 DFT 分类下：

| 节点 | 说明 | 默认参数 |
|------|------|---------|
| `cp2k_geopt` | 几何优化 | PBE, DZVP-SR, 350 Ry, OT |
| `cp2k_static` | 单点能量 | PBE, DZVP-SR, 350 Ry, OT |
| `cp2k_cellopt` | 晶胞优化 | PBE, DZVP-SR, 350 Ry, OT |
| `cp2k_md` | AIMD | PBE, 350 Ry, OT, NVT, 300K |
| `cp2k_freq` | 频率分析 | PBE, 350 Ry, OT, eps 1e-7 |

每个节点均包含完整的 param_schema（functional, basis_set, cutoff, scf_method, vdw, optimizer, charge, cp2k_command 等）和 help_text。

#### workflow_run.py
新增 `"cp2k"` 计算类别：
```python
"cp2k": {
    "label": "CP2K (DFT)",
    "node_types": ["cp2k_geopt", "cp2k_static", "cp2k_cellopt", "cp2k_md", "cp2k_freq"],
}
```

#### workflow_engine.py（+423 行）

**注册**:
- `CP2K_NODES` 集合
- 在 `execute_workflow()` 和 `_submit_and_monitor()` 两处调度逻辑中加入 CP2K 分支

**`_generate_cp2k_inputs()` 方法**（~300 行）:
- 从 pymatgen Structure 解析结构
- node_type → CP2K RUN_TYPE 映射
- 完整的 project.inp 生成（GLOBAL + FORCE_EVAL + DFT + SUBSYS + MOTION）
- OT/DIAG 分支 + smearing + outer_scf
- 全部泛函的正确处理（hybrid + HF section）
- VDW、K-Points、DFT+U
- &VIBRATIONAL_ANALYSIS 顶层 section
- 固定原子（元素 + 索引）→ &CONSTRAINT > &FIXED_ATOMS
- 运行命令：`mpirun {cp2k_command} -i project.inp -o project.out`

**辅助函数**:
- `_cp2k_valence_electrons()`：GTH 赝势价电子数映射表

---

## 三、总结对比

| 维度 | Max 初始版 | leshenzhang 修改后 |
|------|-----------|-------------------|
| Run Type | 4 种 | 7 种 |
| Functional | 5 种 | 14 种（含 meta-GGA、hybrid） |
| VDW | 3 种 | 4 种（+DFT-D4） |
| Periodic | 3 种 | 8 种 |
| SCF 方法 | 仅 OT | OT + Diagonalization 双分支 |
| Smearing | 无 | FERMI_DIRAC / ENERGY_WINDOW |
| K-Points | 无 | Monkhorst-Pack |
| DFT+U | 无 | per-element L 和 U-J |
| UKS 逻辑 | 仅奇偶判断 | OT/DIAG/smearing 联动 |
| 固定原子 | selected / z_below | + 按元素 / 按索引范围 |
| 高级功能 | 无 | LRIGPW, LS_SCF, 表面偶极, 电场, 磁化, 居中, 晶胞重复, print 选项等 20+ |
| 后端 API | 无 | 完整 FastAPI 路由 |
| 工作流 | 无 | 5 种节点 + 引擎集成 |
| XC 语法 | 统一简写 | 各泛函族完整正确语法 |
| 生成逻辑 | ~120 行基础版 | ~500 行，含完整计算化学惯例 |
