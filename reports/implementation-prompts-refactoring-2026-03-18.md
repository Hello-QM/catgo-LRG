# 实施 Prompts: 大文件拆分

**日期:** 2026-03-18
**分支:** `CatGo-PRO`
**参考:** `reports/refactoring-plan-large-files-2026-03-18.md` (完整拆分方案)
**原则:** 只提取逻辑到 `.svelte.ts` / `.ts` 模块。不改行为。`pnpm check` 必须 0 errors。

---

## 必读文档

**开始之前，必须完整阅读以下文件：**
- `reports/refactoring-plan-large-files-2026-03-18.md` — 完整拆分方案（每个文件的模块边界、共享状态、风险等级、Svelte 5 约束）
- 对应的 `CLAUDE.md` 文件（`desktop/CLAUDE.md`, `src/lib/workflow/CLAUDE.md`）

## Svelte 5 关键约束（每次修改都要检查）

1. **$state 必须在组件上下文中创建** — `.svelte.ts` 中用 factory function 模式
2. **不要 spread-replace $state 对象** — 必须 in-place mutate
3. **$derived.by 不能可靠追踪 Set/Map** — 用 $effect + $state bridge
4. **异步 $effect 必须用 generation counter** — 防止 stale 结果
5. **$effect.pre 用于渲染前状态** — bond computation 等

---

## 实施状态

| # | 文件 | 目标 | 状态 |
|---|------|------|------|
| R1 | Structure.svelte (5142 行) | → ~3500 行 | 🔲 |
| R2 | App.svelte (3603 行) | → ~3200 行 | 🔲 |
| R3 | StructureScene.svelte (3560 行) | → ~2800 行 | 🔲 |
| R4 | WorkflowEditor.svelte (3534 行) | → ~2700 行 | 🔲 |
| R5 | Sidebar.svelte (3480 行) | → ~2100 行 | 🔲 |

---

## Prompt R1: Structure.svelte 拆分

```
请拆分 src/lib/structure/Structure.svelte (5142 行)。

## 先读这些文件
1. reports/refactoring-plan-large-files-2026-03-18.md — 找到 "1. Structure.svelte" 部分
2. src/lib/structure/Structure.svelte — 完整阅读
3. src/lib/structure/controllers/ — 了解已提取的 controller 模式

## 提取清单

### 1A: state/selection-state.svelte.ts (~200 行)
从 Structure.svelte 提取：
- selected_atoms 跟踪（opacity/history 状态是 inline 的）
- selection_opacity 状态和相关 $effect
- atom_opacity_overrides, bond_opacity_overrides Maps
- opacity_history 栈和 undo 逻辑
- structure_history, selection_history 数组
- color_picker_targets, 颜色覆盖函数

用 factory function 模式：
```typescript
export function create_selection_state(deps: { structure: () => AnyStructure | null }) {
  let selected_atoms = $state(new Set<number>())
  // ...
  return { selected_atoms, ... }
}
```

### 1B: state/charge-labels-state.svelte.ts (~120 行)
从 Structure.svelte 提取：
- visible_charge_labels Set
- charge_label_offsets SvelteMap
- charge_label_colors Map
- 清理 $effect（结构变化时移除过期索引）
- toggle/show/hide/remove label 函数

### 1C: state/measurement-state.svelte.ts (~80 行)
从 Structure.svelte 提取：
- measurement_refs 数组
- selected_measurement 状态
- add/delete/update measurement 函数

### 1D: display-pipeline.ts (~150 行) — 纯函数
从 Structure.svelte 提取这些纯计算函数（不含响应式状态）：
- apply_cell_transform(structure, cell_type) → transformed_structure
- compute_pbc_images(structure, show_images) → image_atoms
- 其他不依赖 $state 的变换计算

⚠️ 不要提取 $derived 链！$derived 必须留在 Structure.svelte 中。只提取被 $derived 调用的纯函数。

## 重要约束
- Structure.svelte 中的 $derived 响应链（structure → supercell → PBC images → displayed_structure）不能拆分
- 只提取状态管理和辅助函数，不提取响应链
- 每提取一个模块后用 pnpm check 验证

## 验证
```bash
pnpm check 2>&1 | grep "Error:" | wc -l  # 必须为 0
```
```

---

## Prompt R2: App.svelte 拆分

```
请拆分 desktop/App.svelte (3603 行)。

## 先读这些文件
1. reports/refactoring-plan-large-files-2026-03-18.md — 找到 "3. desktop/App.svelte" 部分
2. desktop/App.svelte — 完整阅读
3. desktop/state/ — 了解已提取的状态模块

## 提取清单

### 2A: desktop/lib/tab-manager.svelte.ts (~200 行)
从 App.svelte 提取：
- tabs 数组状态
- active_tab_id 状态
- tab_states Record
- tab_counter
- create_tab(), close_tab(), switch_tab(), reorder_tabs() 函数
- tabs_with_badges 计算

用 factory function 模式创建，App.svelte 中调用。

### 2B: desktop/lib/close-all-helper.ts (~100 行)
从 App.svelte 提取：
- close-all 对话框的入口构建逻辑
- batch save + close 执行逻辑
- 这些是纯函数，不需要 $state

### 2C: desktop/lib/keyboard-shortcuts.ts (~80 行)
从 App.svelte 提取：
- 快捷键注册映射
- register_keyboard_shortcuts(handlers) → cleanup
- 纯函数，不需要 $state

## 验证
```bash
pnpm check 2>&1 | grep "Error:" | wc -l  # 必须为 0
```
```

---

## Prompt R3: StructureScene.svelte 拆分

```
请拆分 src/lib/structure/StructureScene.svelte (3560 行)。

## 先读这些文件
1. reports/refactoring-plan-large-files-2026-03-18.md — 找到 "4. StructureScene.svelte" 部分
2. src/lib/structure/StructureScene.svelte — 完整阅读

## 提取清单

### 3A: bond-computation-controller.svelte.ts (~300 行)
从 StructureScene.svelte 提取：
- bond_connectivity, h_bond_connectivity 状态
- bond_pairs, h_bond_pairs 派生
- Worker 竞态管理（bond_computation_gen counter）
- trigger_bond_recompute(), compute_bonds_async() 等
- 氢键检测逻辑

用 factory function 模式。

### 3B: charge-label-rendering.svelte.ts (~150 行)
从 StructureScene.svelte 提取：
- 电荷标签 HTML overlay 渲染逻辑
- 标签拖拽偏移
- 编辑模式状态
- charge_label_entries 派生

### 3C: interaction-handlers.ts (~250 行) — 纯函数
从 StructureScene.svelte 提取：
- hover 检测逻辑（ray-sphere intersection）
- click/contextmenu 事件处理
- 选择切换逻辑

### 3D: depth-cue-helpers.ts (~100 行) — 纯函数
从 StructureScene.svelte 提取：
- compute_depth_range()
- get_depth_color()
- update_depth_cue_uniforms()

⚠️ 不要提取 atom_data 派生和 Three.js InstancedMesh 管理。这些必须留在组件中。

## 验证
```bash
pnpm check 2>&1 | grep "Error:" | wc -l  # 必须为 0
```
```

---

## Prompt R4: WorkflowEditor.svelte 拆分

```
请拆分 src/lib/workflow/WorkflowEditor.svelte (3534 行)。

## 先读这些文件
1. reports/refactoring-plan-large-files-2026-03-18.md — 找到 "5. WorkflowEditor.svelte" 部分
2. src/lib/workflow/WorkflowEditor.svelte — 完整阅读
3. src/lib/workflow/CLAUDE.md — 了解核心状态

## 提取清单

### 4A: workflow-canvas-interaction.svelte.ts (~400 行)
从 WorkflowEditor.svelte 提取：
- drag, conn, pan, zoom, panning 状态
- on_canvas_mousedown/mousemove/mouseup 事件处理
- 连线绘制逻辑
- box select 逻辑

用 factory function，接收 nodes/edges/sel_nodes 引用。

### 4B: workflow-execution.svelte.ts (~300 行)
从 WorkflowEditor.svelte 提取：
- show_run_dialog, workflow_status, monitor_handle 状态
- run_workflow(), pause_workflow(), resume_workflow()
- WebSocket monitor setup/teardown
- execution_error 状态

### 4C: workflow-history.svelte.ts (~80 行)
从 WorkflowEditor.svelte 提取：
- history[] 数组, hist_idx
- push_history(), undo(), redo(), clear_history()
- 纯状态管理

### 4D: workflow-clipboard.svelte.ts (~100 行)
从 WorkflowEditor.svelte 提取：
- clipboard 状态
- copy_selection(), paste_clipboard()
- clone_for_paste() 辅助函数

### 4E: workflow-change-detection.svelte.ts (~100 行)
从 WorkflowEditor.svelte 提取：
- known_updated_at, external_change_detected
- poll_timer
- setup_external_change_polling()

⚠️ 不要提取 SVG 画布渲染模板。不要提取 nodes/edges 核心状态。

## 验证
```bash
pnpm check 2>&1 | grep "Error:" | wc -l  # 必须为 0
```
```

---

## Prompt R5: Sidebar.svelte 拆分

```
请拆分 desktop/Sidebar.svelte (3480 行)。

## 先读这些文件
1. reports/refactoring-plan-large-files-2026-03-18.md — 找到 "6. Sidebar.svelte" 部分
2. desktop/Sidebar.svelte — 完整阅读
3. desktop/sidebar-data.ts, desktop/sidebar-utils.ts — 已提取的辅助

## 提取清单

### 5A: desktop/sidebar/hpc-browser.svelte.ts (~500 行)
从 Sidebar.svelte 提取：
- hpc_current_path, hpc_files 状态
- hpc_file_tree_key（强制刷新键）
- hpc_merging_dir, hpc_merge_status 合并状态
- navigate_hpc(), upload_file(), merge_structures() 函数
- HPC 文件操作: delete_remote_file(), rename, copy, move

用 factory function 模式。

### 5B: desktop/sidebar/fs-browser.svelte.ts (~400 行)
从 Sidebar.svelte 提取：
- fs_current_dir, fs_items 状态
- fs_browser_open, fs_error, fs_loading
- fs_browse(), fs_export_structure() 函数
- 本地文件操作: mkdir, delete, rename

### 5C: desktop/sidebar/context-menus.ts (~250 行) — 纯函数
从 Sidebar.svelte 提取：
- 三个右键菜单（项目、结果、文件）的 handler 函数
- open_project_context_menu(), open_result_context_menu(), open_file_context_menu()

### 5D: desktop/sidebar/rename-save.svelte.ts (~150 行)
从 Sidebar.svelte 提取：
- renaming_project_id, renaming_result_id, rename_value 状态
- show_save_dialog, save_target_project 状态
- start_rename(), commit_rename(), open_save_dialog(), save_structure()

### 5E: desktop/sidebar/cwd-sync.svelte.ts (~80 行)
从 Sidebar.svelte 提取：
- BroadcastChannel + CustomEvent 终端 CWD 同步逻辑
- setup_cwd_sync() 函数

⚠️ 不要提取项目树渲染模板和拖拽逻辑。这些和 UI 耦合太深。

## 验证
```bash
pnpm check 2>&1 | grep "Error:" | wc -l  # 必须为 0
```
```

---

## 执行顺序

按风险从低到高：

```
R2 → App.svelte         (最简单，tab 管理和快捷键是独立逻辑)
R4 → WorkflowEditor     (history/clipboard/execution 边界清晰)
R5 → Sidebar            (HPC/FS browser 独立性强)
R3 → StructureScene     (bond computation 已有 worker，提取清晰)
R1 → Structure.svelte   (最复杂，涉及响应链边界)
```

每个 Prompt 完成后：
1. `pnpm check` — 0 errors
2. 启动 `pnpm desktop:serve` 手动验证基本功能
3. commit + push
4. 下一个

## 通用验证清单

每次拆分后检查：
- [ ] `pnpm check` 0 errors
- [ ] 结构查看器能加载 POSCAR
- [ ] 工作流编辑器能拖拽创建节点
- [ ] 侧栏能展开/折叠
- [ ] HPC 文件浏览正常（如果改了 Sidebar）
- [ ] 撤销/重做正常（如果改了 WorkflowEditor）
