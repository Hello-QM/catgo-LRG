# MOF Phase 2: Cap 替换引擎 + 高级分析

读 memory/project_mof_phase2_plan.md，了解当前 MOF 分析的完成状态和已知教训。

## 核心任务：MOF Cap 自动识别与替换

用户的工作流：加载 MOF-808 结构 → 自动识别所有 Cap（封基，如 CO₂CH₂CH₂PO₃H₂）→ 选择一个新分子链 → 一键批量替换所有 Cap → 导出新结构。

### 步骤 1：Cap 替换引擎（Rust + 前端）

在 `extensions/rust/src/mof/` 新建 `cap_replace.rs`：

需要使用AI来验证？ 我想要确保这个功能是完美的！

1. **定位锚点**：对每个 Ligand SBU，找到连接 Node 的 anchor 原子（cap 侧）和 Node 侧的 attachment 原子
2. **删除 Cap 原子**：移除 Ligand SBU 的所有原子，保留 Node attachment 原子
3. **插入新片段**：
   - 输入：新分子片段（xyz 坐标 + 指定的 bonding atom）
   - 对齐：旋转/平移新片段使 bonding atom 对准 attachment 点，方向沿原 cap 的键轴
   - 写入新坐标到结构
4. **批量模式**：对结构中所有同类 Cap 执行相同替换
5. **输出**：替换后的完整结构（Structure 对象）

WASM 绑定：`replace_mof_caps(structure_json, mof_clusters_json, new_fragment_json) -> String`

### 步骤 2：分子片段输入

前端 `src/lib/structure/Structure.svelte` MOF Topology section 新增：
- "Replace Caps" 按钮（在 Analyze 结果下方）
- 片段输入方式：SMILES 字符串 → 用 RDKit (后端 Python) 或 Open Babel 生成 3D 坐标
- 或者直接从文件导入片段（xyz/mol2）
- 预览：替换前后对比
- "Apply" 执行替换，"Export All" 批量导出

### 步骤 3：批量替换 + 导出

- 支持输入多个 SMILES → 每个生成一个新结构
- 批量导出为 CIF 或 POSCAR（zip 打包下载）

## 其他 Phase 2 任务

### RAC 描述符引擎 (Rust/WASM)
- 参考 https://github.com/hjkgrp/molSimplify 的 `Informatics/graph_racs.py`
- 新建 `extensions/rust/src/mof/rac.rs`
- BFS 图遍历，5 属性 × 4 范围 × depth 0-3 × 2 运算 = 134 特征
- 前端显示表格 + CSV 导出

### 1D Rod SBU 检测
- 参考 molSimplify 的 `detect_1D_rod()`
- 新增 `SbuType::Rod`，MIL-53 等无限金属链不拆碎

### Functional Group 识别
- Linker 上非 C/H 且不配位金属的原子 = 功能团（-NH₂, -OH, -NO₂ 等）

## Phase 3 任务

### WL 图哈希
- `extensions/rust/src/mof/wl_hash.rs`，SBU/linker 去重

### 孔道分析
- 后端 Python 调 Zeo++，计算 LCD/PLD/ASA

### ML 稳定性预测
- 后端 Python (TensorFlow)，输入 RAC 特征，预测热/水/酸稳定性

## 重要教训（必须遵守）

1. MOF bond detection 用 `detect_bonds_radii` + `include_periodic_images: true`，**不要用 CrystalNN**（漏有机键）
2. MOF 分析跑在 base `structure` 上，不是 `displayed_structure`（避免 image atoms）
3. 耗时计算不要同步阻塞主线程（polyhedra 用 CrystalNN 曾卡死 UI）
4. Linker vs Cap 判定用 periodic crossing detection（不是简单数 image offset）
5. `detect_bonds_radii` 默认跳过 PBC 键（`image != [0,0,0]`），MOF 必须传 `include_periodic_images: true`

## 参考库

- molSimplify: https://github.com/hjkgrp/molSimplify
- MOFSimplify: https://github.com/hjkgrp/MOFSimplify
- Zeo++: http://www.zeoplusplus.org/

## 测试结构

`/home/james0001/Downloads/mof-808/I-3.cif` — MOF-808 + CO₂CH₂CH₂PO₃H₂ phosphonate cap

## 工作环境

- 目录: `/home/james0001/project/catgo/.worktrees/split-files`
- 分支: `split-files`
- Rust WASM 构建: `cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm`
- 前端检查: `pnpm check`
- 测试: `cd extensions/rust && cargo test`
