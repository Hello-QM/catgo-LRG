# Overlay 目标上下文审计 (多视口"作用对象"全量清单)

> 2026-07-10。三路并行审计: 全应用弹层清单 (~111 项)、pane/viewport 架构与
> 模糊状态普查、提交链路目标解析追踪。本文档是规范第二十条要求的清单 +
> 本轮已落地的基础设施与迁移记录 + 后续批次计划。

## 一、身份体系 (已存在, 基础设施直接复用)

- **稳定视口标识 `viewer_id = ${tab_id}:${leaf_id}`**: leaf id 一次铸造
  (`desktop/pane-tree.ts` `next_id()`), 分屏/合并/拖分隔线/最大化均不变;
  `PaneTree.svelte` 按 `leaf.id` keyed 渲染, 组件实例跨重排存活。
- **`viewer-registry.svelte.ts`**: 按 viewer_id 注册 `ViewerManifest`
  (filename/label/formula/kind/active/editable) + `ViewerHandle.get_structure()`
  — 客户端可直接解析任意 pane 的活结构, 提交时无需走后端全局端点。
- **文档身份**: `LibraryEntry.id = crypto.randomUUID()`; pane↔entry 经
  `PaneState.library_entry_id` 绑定。
- **不稳定标识 (仅限显示)**: `pane_number` = `findIndex+1` (布局重排即变),
  `pane_position` = 几何别名。业务逻辑禁止使用。

## 二、模糊"当前/激活"全局单例普查 (歧义源)

| 单例 | 位置 | 读者 (提交时) | 判定 |
|---|---|---|---|
| `current-structure` "最后加载的结构" | `src/lib/structure/current-structure.svelte.ts` | 工作流捕获、CatBot | **UNSAFE**(工作流) / MIXED(CatBot 单一全局助手, by design) |
| `GET /view/structure/current` 无 panel_id | `server/.../view_capture.py:376` default→首个有结构的 pane | 工作流三件套 | **UNSAFE** — "显示窗口 2、操作窗口 1"的直接根源 |
| `viewer-registry.active_viewer_id` | viewer-registry.svelte.ts | CatBot pane 定位兜底 | MIXED (工具显式传 viewer_id 时安全) |
| `terminal-registry._active_id` | terminal-registry.svelte.ts | CatBot 终端工具 | MIXED |
| `modal.import_target_tab = 'structure-1'` 硬编码 | `desktop/state/modal-state.svelte.ts:26` | DB/搜索/粘贴导入落点 | **P2 待修** (默认第一个 tab) |
| App 级 `get_current_structure()` (active leaf 解析) | `desktop/App.svelte:833` | Sidebar 保存 | MIXED (侧栏是全局面, active 是唯一合理解) |

## 三、弹层分类清单 (~111 项, 三路审计合并)

**全局级 (10 项)** — Toast / DownloadManager / UpdateBanner / DiagnosticsPanel /
Nav / TabBar 菜单 / 主题·字号·语言控件等。不绑视口, 不显示窗口编号。无需迁移。

**工作区级 (26 项)** — CloseAllModal / ExportSaveDialog / tab 关闭·布局确认 /
Optimade·Pubchem·Paste 导入族 / Sidebar 右键菜单+改名保存 / ConnectDialog /
RunConfigDialog / PauseDialog / 插件族 / Popout 窗口族。作用于项目/工作区,
标题应显示工作区对象而非单一视口编号。导入族的落点选择 (import_target) 属
P2 批次。

**对象级 (~75 项)** — 关键事实: **绝大多数是 per-Structure-instance 挂载 +
`bind:structure`**(BuildPane 14 子页 / OptimizationPane / AnalysisPane 族 /
IOPane+ExportPane 10 导出面板 / ContextMenu / HpcUploadDialog / CellSelect /
Trajectory·BZ·PD·Cube·Plot 控制面板 / WorkflowEditor 节点级模态 12 项 …),
数据流天然目标安全 (提交链路追踪判定 SAFE: 导出按值捕获、优化 bind、编辑
per-instance 闭包、终端/轨迹稳定 leaf id)。它们缺的是**目标可视化**
(标题不显示窗口/文件名) — 分批接入 `OverlayTargetHeader`。

**UNSAFE 名单 (数据流错误, 本轮全部修复):**

| # | 位置 | 症状 | 修复 |
|---|---|---|---|
| 1 | `WorkflowPane.svelte` create/send | fetch 无 panel_id → 后端兜底首个 pane | 冻结 targetContext + `resolve_viewer(viewer_id).handle.get_structure()`; 探针证明捕获 NaCl 8 原子而非首载 H2O |
| 2 | `StructureInputDialog` Capture from Viewer | 同上 + 客户端单例兜底 | 目标选择器: 恰一视口自动绑定、多视口必须手选 (禁默认第一个)、零视口显式"最近加载"; 捕获后显示来源窗口 |
| 3 | `WorkflowEditor.fill_empty_structure_inputs` | 全局单例注入 | 恰一视口用它、零视口用单例、多视口拒绝静默注入 (结构化日志) |
| 4 | `App.handle_sidebar_open_workflow` | 编辑器 `findFirstEmptyLeaf ?? active_leaf` — 从 pane2 创建却顶掉 pane1 | 新增 `target_leaf_id` 参数, WorkflowPane 的编辑器开进发起源 leaf; 探针: 标签保持 OH2 |

## 四、本轮落地的基础设施

- `src/lib/overlay/overlay-target.svelte.ts`: `OverlayTargetContext` /
  `OverlayTargetPolicy` (fixed·follow-active·user-selectable) /
  `OverlayInstance` 注册表 (多实例隔离+日志) / **稳定显示编号铸造**
  (首铸按 pane 顺序、重排不改号、关闭后回收) / `create_viewport_target_context`
  (打开时冻结) / `validate_target` (closed/empty 失效判定) /
  `resolve_target_structure` (提交时解析冻结视口活结构) /
  `snapshot_operation_target` (异步按值快照) / dev 断言 + 结构化日志 /
  `flash_viewport` 视口联动高亮 (800ms, 不动相机/选择/焦点)。
- `src/lib/overlay/OverlayTargetHeader.svelte`: 统一"功能名 · 窗口 N +
  文件名副标题 (省略号+hover 全名)"、失效/空状态横幅、user-selectable
  目标切换菜单 (✓ 当前项、切换不关弹层)。i18n en/zh (`common.overlay_*`)。
- `Structure.svelte`: 视口高亮消费端 (`overlay-target-flash` 描边)。

## 五、验收 (overlay-target-probe, 11/11, exitCode 门禁, 探针已删)

双窗不同结构 (H2O + NaCl): 双实例 header "Window 1 · H2O" / "Window 2 ·
NaCl.vasp" 并存; NaCl 实例创建捕获 8 原子 [Na,Cl] (修复前为 H2O 3 原子);
编辑器占发起源 leaf (标签仍 OH2); H2O 实例创建捕获 3 原子 [O,H]; 全程零
console/page error。

## 六、后续批次 (规范条目 → 计划)

- **P1**: 对象级弹层批量接 OverlayTargetHeader (导出/优化/HPC 上传/删除确认
  先行); 确认文案带目标名 (§8); 视口角标 (§7 合并计数); DraggablePane
  多实例级联错位 (本轮发现两实例同位叠放)。
- **P2**: 导入落点 (`import_target_tab` 硬编码) 显式选择; 全局工具栏/命令面板
  多视口先选目标 (§13/14); follow-active 面板声明化 (§5)。
- **P3**: 结构 revision + 异步冲突提示 (§10 后半, 目前按值快照已防错写);
  跨工作区失效 (§16, 当前 project 不分区 pane); 嵌套弹层上下文继承的
  系统化检查 (§12, WorkflowEditor 节点模态已天然按 node 绑定)。
