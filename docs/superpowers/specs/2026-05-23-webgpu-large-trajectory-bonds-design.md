# 设计稿：超大轨迹 WebGPU 专用渲染路径

日期：2026-05-23
状态：设计已与用户对齐，待 spec 评审 → 实现计划

## 1. 背景与问题

CatGO 当前判键流程（`src/lib/structure/bond-computation-controller.svelte.ts`）：

- 非轨迹：`compute_bond_connectivity`，指纹门控，变化时调 `compute_bonds_sync`（ferrox-wasm，主线程同步）。
- 轨迹：`TRAJ_SYNC_THRESHOLD = 1000` 原子以下主线程同步逐帧算；以上节流异步 worker，单任务在途；帧缓存 `TRAJ_FRAME_CACHE_MAX = 32`。
- 删原子走 X4/X5 增量 drop-reindex 快速路径并伪造指纹屏蔽重算。

ferrox-wasm 判键确认为**纯成对**（距离 + 共价半径/电负性，无邻居上限、无配位/价态依赖，`extensions/rust/src/bonding.rs`）。

**核心痛点（本设计针对）**：百万原子 × 万帧轨迹下，**每帧从头重算全体键拓扑**在浏览器中不可能流畅，且百万原子球本身在 Three WebGL `InstancedMesh` 下也是巨大渲染负担。逐帧重算 + 逐帧建几何 → 直接卡死。这是架构问题，调参无解。

（注：删原子断键 / 不成键的增量路径问题是**另一个**独立 bug，本 spec 不处理，单列后续。）

## 2. 目标

用户手动开启"大体系性能模式"后，超大体系（百万原子级）轨迹播放/拖拽流畅，逐帧反应式键经 GPU 计算并 GPU 常驻渲染。常规体系路径完全不动、零回归。

## 3. 锁定决策（与用户对齐）

1. **方案 A — 独立大体系 GPU 路径**，与现有 WebGL/Three 路径并存。常规体系不动。
   - 不选整体迁移到 `three/webgpu`（B）：B 需重写全部自定义 GLSL shader、重写 GPU 拾取、async 引导、全查看器回归风险，数月工程；且 compute 仍需 CPU 回退（B 不省这块）。A 风险局部、见效快。
2. **逐帧重算键**（反应式，体现成键/断键），GPU compute。
3. **键 GPU 常驻**；CPU `bond_connectivity` 仅在暂停/交互时一次性回读；播放期间零回读。用户明确："可以，只要能看。"
4. **降级渲染器**：impostor 球 + 实例化键 + 简化着色。
   - 该模式**禁用**：label、polyhedra、gizmo、测量。
   - 该模式**保留**：原子选中高亮 + GPU 拾取（能点原子看信息）。
5. **PBC**：最小镜像边界键（compute 做 27-镜像/最小镜像距离），**不**生成 ghost 镜像原子。符合既有"跨晶胞键必须显示"行为。
6. **判键策略 v1**：仅 `atom_radii`（距离 + 共价半径 + 容差）。`electroneg_ratio` / `solid_angle` GPU 模式不支持（走 CPU 或不可选）。
7. **激活 = 手动开关**。用户在 UI 切"大体系性能模式"，不自动按原子数切。
8. **无 WebGPU 回退 = CPU 路径 + 上限提示**。无 `navigator.gpu` 时保留现有 CPU/worker 路径，超硬性原子上限时提示"WebGPU 不可用，超大体系性能受限"。
9. **成键距离可自定义**。compute uniform 携带容差 / 半径缩放 / `max_bond_dist`，实时可调，改动即对当前帧重算；与现有 CPU `bonding_options` 共用同一套 UI 滑块驱动两条路径。

## 4. 数据流（每帧）

```
当前帧坐标 (N×3 f32，1M ≈ 12MB) → GPU storage buffer (upload)
  → compute pass:
       1. 建均匀网格 (uniform grid / cell list)，cell 边长 ≥ max_bond_dist
       2. 每原子扫相邻 27 格候选
       3. 最小镜像距离 + atom_radii 判据 (dist ≤ (r1+r2)*scale + tolerance，且 ≤ max_bond_dist)
       4. 原子追加 (atomic counter) 写 bond buffer：(idx_a, idx_b) 或预算端点
  → render pass:
       - impostor 球 (原子)：instanced quad + 球面 raymarch，读坐标 buffer
       - 实例化圆柱/线 (键)：读 bond buffer
       - 相机矩阵从 Three camera 同步为 uniform
播放期间不回读 CPU。
```

暂停 / 选中 / 导出 / 测量 / mof-analysis 等 CPU 消费触发时：对当前帧跑一次 compute + 回读 bond buffer → 填 `bond_state.bond_connectivity`，供既有 CPU 模块使用。

## 5. 模块边界

| 模块 | 职责 | 输入/依赖 | 输出 |
|---|---|---|---|
| `gpu/webgpu-context.ts` | adapter/device 获取、能力检测、async init、回退信号 | `navigator.gpu` | device 句柄 / null |
| `gpu/bond-compute.ts` | WGSL compute pipeline：均匀网格 + atom_radii 判键 + 最小镜像 PBC | 坐标 buffer、晶格、元素共价半径 LUT、容差/缩放/max_bond_dist uniform、device | bond buffer (a,b) + count |
| `gpu/large-system-renderer.ts` | WGSL render：impostor 球 + 实例化键、相机 uniform、选中高亮、id-buffer 拾取 | 坐标 buffer、bond buffer、相机、选中集合、device | 画面 + 拾取 id 读回 |
| `gpu/large-system-mode.svelte.ts` | 编排：模式开关、WebGL↔WebGPU canvas 切换、帧上传、播放循环、暂停/交互回读桥接 `bond_state` | 上述三者、StructureScene、轨迹播放器、`bond_state` | — |

集成点：
- StructureScene：模式开启时隐藏 WebGL canvas、激活 WebGPU canvas；关闭时反向。
- 轨迹播放器驱动帧号 → `large-system-mode` 上传该帧坐标。
- 回读时写 `bond_state.bond_connectivity`（与现有消费模块兼容的索引空间）。
- 拾取复用/扩展 `gpu-picker-integration` 思路（id render target 回读）。
- 成键距离 UI：现有 `bonding_options` 滑块同时写 CPU 路径和 GPU compute uniform。

## 6. 测试策略

- **WGSL compute 正确性（黄金对比）**：小/中体系，GPU 键列表 vs CPU `detect_bonds_atom_radii`，含：
  - 非周期分子；
  - PBC 最小镜像跨边界键；
  - 不同容差/缩放/max_bond_dist。
- 模式开关 / canvas 切换逻辑单测。
- 无 WebGPU 回退（mock 无 device）走 CPU + 提示。
- 暂停回读填充 `bond_connectivity` 与 CPU 一致性测。
- 键 buffer 溢出截断 + 警告路径测。
- 性能冒烟（手动）：1M 原子 上传 + compute + render 帧预算 < 目标（如 60fps 拖拽 / 流畅播放）。

## 7. 风险与开放点

- **键 buffer 溢出**：百万原子下键数可达数百万 → 显存压力。设 max-bond 上限，超出截断 + 警告。上限值实现时定。
- **Float32 精度**：大晶胞坐标精度，必要时减去帧质心 / 用 cell-relative 坐标。
- **运行时 WebGPU 可用性**：Electron/Tauri WebView 的 Chromium 版本需确认支持 WebGPU；否则回退路径。
- **拾取在百万原子下的成本**：id render target 回读单点拾取可接受（非每帧）。
- **相机/坐标一致性**：WebGPU 路径相机矩阵需与 Three 路径完全一致，切换无跳变。

## 8. 不在本 spec 范围

- 删原子增量路径 drop-reindex / 指纹屏蔽导致的氢键断键问题（独立 bug，单列）。
- `electroneg_ratio` / `solid_angle` 的 GPU 实现。
- 整体迁移到 `three/webgpu`（方案 B，未来独立计划）。
- 自动按原子数激活（当前手动）。
