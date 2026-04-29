# Bug 报告：Phase 1+2 前端集成缺失

**日期:** 2026-03-18
**分支:** CatGo-PRO
**严重程度:** 高 — 24 个 Prompt 的后端功能大部分无法在 UI 中看到或使用

---

## 问题总结

Phase 1+2 实施了 24 个 Prompt，但前端集成严重不足。大部分功能只存在于后端 API 和 CatBot 工具层，用户在 GUI 中**看不到任何新功能**。

---

## Bug 列表

### Bug F-1: DiagnosticsPanel 完全孤立（HIGH）

**文件:** `src/lib/DiagnosticsPanel.svelte` (92 行，功能完整)

**问题:** 组件创建了但**没有被任何页面引用**。
- 零 import
- 零 render
- 没有路由、按钮、菜单项指向它

**影响:** 用户无法访问系统诊断面板（Prompt 14 的全部 UI 价值为零）

**需要:**
- 在 `desktop/App.svelte` 侧栏或设置中添加入口
- 或者在工作流编辑器的某个位置添加 "System Status" 按钮

---

### Bug F-2: BatchStatusPanel 条件永假（HIGH）

**文件:** `src/lib/workflow/NodeStatusPanel.svelte` line 118, 440-442

**问题:** 渲染条件为 `is_batch_node = $derived(node_type.includes('batch'))`，但：
- `NODE_DEFINITIONS` 中没有任何节点类型名称包含 "batch"
- `batch_adsorbate_place` 虽然在后端 `node_sets.py` 注册了，但前端 `node-definitions.ts` 中**没有对应定义**
- 因此条件**永远为 false**，BatchStatusPanel **永远不会渲染**

**影响:** Prompt 9 的整个前端面板（进度条、直方图、分页表格、重试按钮）完全不可见

**需要:**
- 在前端 `node-definitions.ts` 中添加 `batch_adsorbate_place` 节点定义
- 或者修改条件逻辑，让它能检测到 batch 类型的工作流步骤

---

### Bug F-3: 催化分析结果无显示（HIGH）

**文件:** `src/lib/workflow/NodeStatusPanel.svelte`

**问题:** NodeStatusPanel 对以下节点类型的结果**没有任何显示逻辑**：
- `free_energy` 节点 → 计算了 G, ZPE, TS 但不显示
- `energy_compare` 节点 → 计算了排名表但不显示
- `pick_best` 节点 → 选了最优结构但不显示
- OER/CO2RR/NRR 过电位 → 完全没有结果展示区域

**当前行为:** 这些节点完成后只显示 "completed"，没有结果详情。

**影响:** Prompt 10-11, 16 的催化分析计算结果用户看不到

**需要:**
- 在 NodeStatusPanel 中为 `free_energy` 类型添加结果显示（G, ZPE, TS, temperature）
- 为 `energy_compare` 类型添加排名表
- 为 `pick_best` 类型显示最优结构信息

---

### Bug F-4: Volcano Plot 没有可视化组件（HIGH）

**文件:** 不存在

**问题:** 后端 API `/api/workflow/{id}/volcano-plot` 存在且工作正常，但：
- 没有 `VolcanoPlot.svelte` 组件
- 没有 SVG/Canvas 散点图渲染
- 没有理想 volcano 线绘制
- 没有催化剂标注

**影响:** Prompt 11 的 Volcano Plot 功能完全不可用

**需要:**
- 新建 `src/lib/workflow/VolcanoPlot.svelte` — SVG 散点图 + 理想线
- 在催化分析结果面板中集成

---

### Bug F-5: VASP 预设选择器不存在（MEDIUM）

**文件:** `src/lib/workflow/NodeConfigPanel.svelte`

**问题:** 后端有 6 个 VASP 预设（relax, static, slab_relax, freq, band, md），API 端点 `/api/workflow/vasp-presets` 工作正常，但：
- NodeConfigPanel 没有预设下拉菜单
- 用户无法一键选择 "Slab Relaxation" 预设
- 必须手动逐个设置 INCAR 参数

**影响:** Prompt 18 的预设功能用户完全感知不到

**需要:**
- 在 NodeConfigPanel 中为 VASP 节点添加 "Preset" 下拉
- 选择预设后自动填充 INCAR 参数

---

### Bug F-6: d-band center 描述符结果不显示（MEDIUM）

**文件:** `src/lib/workflow/NodeStatusPanel.svelte`

**问题:** `compute_dband` 分析工具在后端和 MCP 中工作正常，但：
- NodeStatusPanel 没有 d-band 结果显示区域
- 没有 d-band center / width / filling 的数值展示
- 计算出来的描述符无法在 UI 中查看

**影响:** Prompt 23 的描述符提取对 GUI 用户不可见

---

### Bug F-7: 结构来源链 (_lineage) 不显示（MEDIUM）

**文件:** 不存在

**问题:** 后端在每个节点完成时记录了完整的 `_lineage` 数组（Prompt 24），但：
- 前端没有任何组件读取或显示 lineage
- 没有面包屑导航、树状图、或时间线视图
- 用户无法追踪 "这个结构是怎么来的"

**影响:** 数据溯源的 UI 价值为零

---

### Bug F-8: 新节点类型未在前端注册（HIGH）

**文件:** 前端的节点定义文件（`node-definitions.ts` 或类似）

**问题:** Phase 2 新增的后端节点类型在前端 `NODE_DEFINITIONS` 中**不存在**：
- `pick_best` — 未注册
- `batch_adsorbate_place` — 未注册
- 用户无法在工作流编辑器中拖拽添加这些节点

**影响:** Prompt 16, 17 的新节点类型用户无法使用

**需要:**
- 在前端 node-definitions 中添加这些节点类型的定义（名称、图标、参数 schema、分类）

---

### Bug F-9: CatBot 新工具未经端到端验证（MEDIUM）

**文件:** `src/lib/chat/workflow-tool-executor.ts`, `src/lib/chat/workflow-tools.ts`

**问题:**
- 5 个新 CatBot 工具（retry_step, get_batch_status, compute_oer, compute_free_energy, list_vasp_presets）已定义并有 handler
- `workflow-tool-executor.ts` 被多处 import（Structure.svelte, tool-handler.ts, WorkflowEditor.svelte）
- **但未经端到端验证**：不确定在实际 AI 对话中工具是否能被正确触发和执行

**影响:** CatBot 催化分析工具可能在实际使用中不工作

**需要:**
- 手动测试：在 CatBot 中输入 "计算 OER 过电位" 看是否触发正确工具
- 确认工具执行路径从 chat-state → tool-handler → workflow-tool-executor 完整

---

## 根因分析

| 根因 | 影响范围 |
|------|---------|
| **前端节点定义未同步** | Bug F-2, F-8 — 后端有新节点类型，前端 NODE_DEFINITIONS 没有 |
| **组件创建但未接入** | Bug F-1 — DiagnosticsPanel 是孤立文件 |
| **结果显示逻辑缺失** | Bug F-3, F-6, F-7 — 后端计算了结果，NodeStatusPanel 不显示 |
| **可视化组件未创建** | Bug F-4 — Volcano Plot 没有前端组件 |
| **UI 入口缺失** | Bug F-5 — 预设 API 存在但没有下拉菜单 |

## 本质问题

**24 个 Prompt 的实施集中在后端逻辑和 API 层，前端集成被严重忽略。** 后端功能完整且验证通过，但用户无法通过 GUI 访问大部分新功能。需要一轮专门的前端集成工作。

---

## 优先级排序

| 优先级 | Bug | 修复工作量 |
|--------|-----|-----------|
| P0 | F-8: 新节点类型前端注册 | 低 — 在 node-definitions 添加条目 |
| P0 | F-3: 催化分析结果显示 | 中 — NodeStatusPanel 添加 3 个 section |
| P0 | F-1: DiagnosticsPanel 接入 | 低 — 在侧栏/设置添加一个按钮 |
| P1 | F-2: BatchStatusPanel 条件修复 | 低 — 修改检测条件 |
| P1 | F-4: Volcano Plot 组件 | 中 — 新建 SVG 散点图组件 |
| P1 | F-5: VASP 预设选择器 | 低 — 添加下拉菜单 |
| P2 | F-6: d-band 结果显示 | 低 — 添加数值显示 |
| P2 | F-7: Lineage UI | 中 — 新建面包屑/时间线组件 |
| P2 | F-9: CatBot 工具验证 | 低 — 手动测试 |
