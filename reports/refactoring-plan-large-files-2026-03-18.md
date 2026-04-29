# Refactoring Plan: Large Svelte Component Splitting

**Date:** 2026-03-18
**Scope:** 5 Svelte components totaling 19,319 lines
**Principle:** Extract state + logic into `.svelte.ts` / `.ts` modules. No behavior changes. All existing tests and runtime behavior must remain identical.

---

## Prior Art

Previous extraction rounds have already established the pattern:

- **Structure.svelte** has 16 controller modules in `controllers/` (tool-handler, transform-controller, viewer-controller, interaction, pencil-mode, build-tools, analysis, settings, xrd-state, file-handlers, context-menu-actions, fragments, etc.)
- **StructureScene.svelte** has 4 modules in `scene/` (visibility, picking, render-data, index)
- **WorkflowEditor.svelte** has `graph-model.ts` (559 lines) and `workflow-commands.ts` (112 lines)
- **desktop/App.svelte** has 4 state modules in `desktop/state/` (sidebar-state, export-state, modal-state, terminal-state) plus `pane-utils.ts`
- **desktop/Sidebar.svelte** has `sidebar-data.ts` and `sidebar-utils.ts`

This plan targets the next round of extractions to bring each file closer to a maintainable size.

---

## Svelte 5 Constraints (apply to ALL extractions)

These constraints are non-negotiable and must be verified for every extraction.

### C1: `$derived` and `$effect` require `$state` in scope
A `.svelte.ts` file using `$state`, `$derived`, and `$effect` runes must be created via a **factory function** called from within the component's `<script>` block. The runes execute in the component's reactive context. A bare module-level `$state()` outside a component context will throw at runtime.

**Pattern:**
```typescript
// foo-controller.svelte.ts
export function create_foo_controller(deps: FooDeps) {
  let internal = $state(...)   // OK — called from component context
  $effect(() => { ... })       // OK
  return { internal, ... }
}
```

### C2: Svelte 5 proxies break on spread-replace
Mutate `$state` objects in-place. Never `obj = { ...obj, key: newVal }` on deeply nested `$state` — it creates a plain object that breaks `@const` reactivity in `{#each}` blocks.

### C3: `$derived.by()` does not reliably track Set/Map prop changes
When a `$derived.by()` needs to depend on a Set or Map from a parent component, bridge it via `$effect` + `$state` (create a local copy that triggers the derived recalculation).

### C4: Generation counters for async `$effect`
Any `$effect` that does async work (WASM, Worker, fetch) must use a generation counter to discard stale results. Increment the counter at the start, capture it, and check `if (gen !== current_gen) return` after each await.

### C5: `$effect.pre` for pre-DOM-update state
Bond computation and similar state that must be settled before Three.js renders a frame must use `$effect.pre`, not `$effect`.

---

## 1. Structure.svelte (5142 lines -> ~3500 target)

**Path:** `src/lib/structure/Structure.svelte`

### 1A. Extract `state/selection-state.svelte.ts` (~200 lines)

**What moves out:**
- `selected_atoms` tracking (currently managed by interaction controller, but opacity/history state is inline)
- `selection_opacity` state and its `$effect` that applies opacity to overrides
- `atom_opacity_overrides`, `bond_opacity_overrides` Maps
- `opacity_history` stack and undo logic
- `structure_history`, `selection_history` arrays
- `color_picker_targets`, color override application functions

**What stays in parent:**
- `$bindable` prop declarations for `selected_atoms`
- Template bindings to StructureScene
- Context menu UI that triggers selection operations

**Svelte 5 gotchas:**
- `atom_opacity_overrides` is a plain `Map` — reads inside `$derived.by` in StructureScene may not trigger. The extraction should convert to `SvelteMap` for reliable tracking, or bridge via `$effect` in StructureScene (which already exists for `_hidden_elements`).
- Selection history push must happen synchronously before the structure mutation that changes `structure.sites.length`, otherwise the cleanup `$effect` (line ~948) may prune the stale selection.

**Risk:** MODERATE — opacity overrides interact with StructureScene's `atom_data` derived, which has known Set/Map tracking issues (see C3). Must verify the bridge pattern works for Map<number, number>.

**Testing strategy:**
1. Select atoms, verify selection highlight renders
2. Adjust opacity slider, verify transparency changes
3. Undo opacity change, verify restoration
4. Select atoms, delete one, verify selection prunes correctly
5. Verify color picker per-atom override persists after deselection

### 1B. Extract `state/charge-labels-state.svelte.ts` (~120 lines)

**What moves out:**
- `visible_charge_labels` Set
- `charge_label_offsets` SvelteMap
- `charge_label_colors` Map
- `charge_color_menu` state (popup position)
- The prune `$effect` (line ~961-976) that cleans stale indices on structure change
- Helper functions: toggle charge label, show all, hide all, remove single label
- Color menu open/close/apply handlers

**What stays in parent:**
- Template for the color popup overlay (`{#if charge_color_menu}` block, line ~7449)
- Prop passing to StructureScene (`visible_charge_labels`, `charge_label_offsets`, etc.)

**Svelte 5 gotchas:**
- `charge_label_offsets` uses `SvelteMap` specifically because regular Map mutations are not tracked by `$derived`. This must remain `SvelteMap` in the extracted module.
- The prune `$effect` reads `structure` reactively but reads `visible_charge_labels` via `untrack()` to avoid circular dependency. This pattern must be preserved exactly.

**Risk:** LOW — charge labels are self-contained with clear prop boundaries. No async operations.

**Testing strategy:**
1. Right-click atom -> toggle charge label on/off
2. Show all / hide all charge labels
3. Drag a charge label, verify offset persists
4. Right-click charge label -> change color
5. Load new structure -> verify stale labels pruned
6. Supercell change -> verify labels survive for valid indices

### 1C. Extract `state/measurement-state.svelte.ts` (~100 lines)

**What moves out:**
- `measure_menu_open` state
- Measurement list management (the `measurements` array is on the interaction controller, but add/remove/prune logic wraps `delete_measurement_from_list` and `prune_measurements` from analysis-controller.ts)
- Measurement toolbar state (which measurement mode is active: distance, angle, dihedral)
- Measurement formatting helpers

**What stays in parent:**
- `interaction` controller reference (owns the actual measurement array)
- Template for measurement display overlay
- StructureScene prop passing for measurement rendering

**Svelte 5 gotchas:** None significant — measurement state is simple scalar/array state.

**Risk:** LOW — measurements are read-mostly, with clear CRUD boundaries.

**Testing strategy:**
1. Click two atoms -> verify distance measurement appears
2. Click three atoms -> verify angle measurement
3. Delete a measurement -> verify removal
4. Change structure -> verify stale measurements pruned

### 1D. Extract `display-pipeline.ts` (~150 lines, pure functions)

**What moves out:**
- `compute_unique_elements()` (already imported from analysis-controller, but the call-site `$derived` wrapping it can stay)
- `prune_charge_labels()`, `prune_measurements()` (already in analysis-controller.ts — no new extraction needed)
- Any remaining inline pure functions for cell transform decisions, supercell validation, PBC image assembly

**What stays in parent:**
- `$derived` / `$effect` wiring that calls these functions
- The `create_transform_controller` factory call (already extracted)

**Note:** The display pipeline is *already largely extracted* into `controllers/transform-controller.svelte.ts`. This item is about catching any remaining inline computation that should join that module. After audit, this may yield only ~50 lines of additional extraction.

**Risk:** LOW — pure functions with no reactive state.

**Testing strategy:** Existing behavior coverage via the transform controller. No new test surface.

### Estimated net reduction: ~500-600 lines (to ~4550)

The remaining ~1600 lines to reach the ~3500 target would come from a future round targeting:
- Electronic analysis pane state (DOS/COHP/Band session management ~200 lines)
- Terminal/chat panel layout state (~100 lines)
- Build tool pane open/close orchestration (~150 lines)
- Template markup consolidation (sub-components for each tool pane's wrapper)

---

## 2. desktop/App.svelte (3603 lines -> ~3200 target)

**Path:** `desktop/App.svelte`

### 2A. Extract `lib/tab-manager.svelte.ts` (~180 lines)

**What moves out:**
- `tab_counter`, `tabs`, `active_tab_id` state
- `active_tab`, `active_tab_type`, `tabs_with_badges`, `active_layout` derived
- `tab_states` record
- `get_active_ts()` helper
- `create_tab()`, `close_tab()`, `switch_tab()` functions
- `tab_close_confirm_id`, `pending_layout_change` state
- Tab rename logic
- `update_tab_label()` — auto-naming from structure formula

**What stays in parent:**
- TabBar component binding
- File-open handlers that call `tab_manager.create_tab()` or `tab_manager.get_active_ts()`
- Layout grid template that reads `tab_manager.active_layout`

**Svelte 5 gotchas:**
- `tab_states` is a `Record<string, StructureTabState>` where each value contains deeply nested `$state` proxies (panes array with structure objects). The factory must return the raw `$state` reference, NOT a getter — otherwise the parent's `{#each}` over panes loses proxy tracking.
- Spread-replace of `tab_states[key]` is explicitly documented as a known bug source (see desktop/CLAUDE.md). The extracted module must enforce in-place mutation.

**Risk:** MODERATE — tab state is the backbone of the desktop shell. Many functions throughout App.svelte read `get_active_ts()`. The extraction must expose a clean API surface that all those call sites can use without excessive refactoring.

**Testing strategy:**
1. Create new tab -> verify it appears and is active
2. Close tab -> verify confirm dialog, then removal
3. Switch tabs -> verify correct pane renders
4. Load structure in pane -> verify tab badge updates
5. Layout change (1-pane to 2-pane) -> verify pane count, lost pane dialog
6. Drag structure between tabs (if supported)

### 2B. Extract `lib/close-all-helper.ts` (~80 lines, pure + async)

**What moves out:**
- `open_close_all_dialog()` function (lines ~107-170)
- `CloseAllEntry` type (already in modal-state.svelte.ts)
- `handle_close_all_confirm()` logic (batch save + close)
- Save-to-DB / save-to-HPC / save-to-file dispatch logic for batch close

**What stays in parent:**
- Modal visibility state (already in `modal-state.svelte.ts`)
- Dialog template

**Svelte 5 gotchas:** None — these are async imperative functions, not reactive state.

**Risk:** LOW — isolated modal logic with clear inputs (tabs, tab_states) and outputs (save actions, tab closures).

**Testing strategy:**
1. Open 3 tabs with structures -> Close All -> verify dialog lists all entries
2. Toggle save checkboxes -> confirm -> verify saves execute
3. Cancel -> verify no tabs closed

### 2C. Extract `lib/keyboard-shortcuts.ts` (~60 lines, pure)

**What moves out:**
- The `handle_keydown` function that dispatches Ctrl+S, Ctrl+W, Ctrl+N, Ctrl+Shift+N, etc.
- Shortcut registration/cleanup

**What stays in parent:**
- `$effect` that attaches the keydown listener
- References to handler functions (save, close tab, new tab) passed as deps

**Svelte 5 gotchas:** None — pure event handler dispatch.

**Risk:** LOW

**Testing strategy:**
1. Ctrl+N -> new tab created
2. Ctrl+W -> close tab dialog
3. Ctrl+S -> save triggered

### Estimated net reduction: ~320 lines (to ~3280)

---

## 3. StructureScene.svelte (3560 lines -> ~2800 target)

**Path:** `src/lib/structure/StructureScene.svelte`

### 3A. Extract `gpu-picker-integration.svelte.ts` (~120 lines)

**What moves out:**
- `GPUPicker` instance creation and lifecycle
- `picker_dirty` state
- `setup_hover_detection()` function (lines 71-139) — the entire hover dispatch that switches between analytic ray-sphere and GPU picking
- `update_gpu_picker()` — rebuilds the picker scene from atom_data
- `LARGE_STRUCTURE_THRESHOLD` constant (2000 atoms)

**What stays in parent:**
- `hovered_idx` state (referenced by many template conditionals)
- `active_tooltip` state
- Threlte `useThrelte()` context (must be passed as dep)
- `atom_data` derived (consumed by the picker)

**Svelte 5 gotchas:**
- `setup_hover_detection()` is called in an `$effect` and returns a cleanup function. The extracted module must return a `setup()` function and a `cleanup()` function, or use the pattern where the factory's internal `$effect` handles its own cleanup.
- `is_large_structure` is a `$derived` that depends on `structure.sites.length`. The factory needs a getter dep for it, not a captured value.
- `picker_dirty` must be set to `true` whenever `atom_data` changes. Currently this is done inline. The extracted module should expose a `mark_dirty()` method or listen to a dep.

**Risk:** MODERATE — GPU picker interacts with Three.js renderer lifecycle. The Threlte context (`useThrelte()`) can only be called inside a Svelte component's `<script>`, so it must be passed as a dependency, not called inside the `.svelte.ts` module.

**Testing strategy:**
1. Load structure with <2000 atoms -> hover atoms -> verify tooltip (ray-sphere path)
2. Load structure with >2000 atoms -> hover atoms -> verify tooltip (GPU picker path)
3. Change structure -> verify picker rebuilds (dirty flag reset)
4. During drag -> verify hover is suppressed

### 3B. Extract `bond-computation-controller.svelte.ts` (~200 lines)

**What moves out:**
- `bond_connectivity` state array
- `last_bond_structure`, `last_bond_strategy`, `last_bond_fingerprint`, `last_elem_fingerprint` tracking state
- `bond_worker_pending` state
- `bond_computation_gen` generation counter
- The `$effect.pre` bond computation block (lines 1683-1780+) — topology detection, position-only fast path, async Worker dispatch
- `h_bond_connectivity` state
- H-bond detection `$effect`
- H-bond generation counter

**What stays in parent:**
- `bond_pairs` derived (computed from `bond_connectivity` + positions — the `$derived.by` that maps connectivity to BondPair objects with 3D coordinates)
- `h_bond_pairs` derived (same pattern)
- Template `{#each}` for Bond rendering

**Svelte 5 gotchas:**
- **Critical:** The bond computation uses `$effect.pre` (not `$effect`) to settle state before the Three.js render frame. The extracted `.svelte.ts` module's `$effect.pre` will still run in the component's reactive context (since the factory is called from the component), so this is safe. But verify the timing is preserved.
- The async Worker path uses a generation counter (`bond_computation_gen`). This counter must NOT be `$state` — it is intentionally a plain `let` to avoid triggering re-renders. The extracted module must preserve this.
- H-bond `$effect` reads and writes `h_bond_connectivity`. The old infinite loop bug (documented in CLAUDE.md) was fixed by splitting connectivity from pairs. The extracted module must maintain this split.

**Risk:** HIGH — bond computation is the most complex reactive chain in StructureScene. The `$effect.pre` timing, async race handling, and the connectivity/pairs split are all subtle. A regression would cause bonds to flicker, disappear, or cause infinite loops.

**Testing strategy:**
1. Load structure -> verify bonds appear
2. Change bonding strategy -> verify bonds recompute
3. Drag atoms -> verify bonds update positions without full recomputation (fast path)
4. Load large structure -> verify async Worker path (check console for worker messages)
5. Toggle H-bonds -> verify no infinite loop, bonds appear correctly
6. Rapidly switch structures -> verify no stale bonds from previous async computation
7. Trajectory playback -> verify bonds don't recompute on every frame (fingerprint check)

### 3C. Extract `charge-label-rendering.svelte.ts` (~100 lines)

**What moves out:**
- `charge_label_entries` derived (line ~1364)
- `editing_charge_site_idx` state
- Charge label drag handling (document-level `pointerdown` with capture, lines ~341-400)
- Charge label edit commit/cancel logic

**What stays in parent:**
- `{#each charge_label_entries}` template with `<extras.HTML>` rendering
- CSS `:global()` pointer-events whitelist rules
- Props received from Structure.svelte (`visible_charge_labels`, `charge_label_offsets`, etc.)

**Svelte 5 gotchas:**
- Charge label drag uses `document.addEventListener('pointerdown', ..., true)` in capture phase. The cleanup must use the same capture flag. If extracted, the `$effect` for listener setup/cleanup must be inside the factory.
- The 3px dead zone and `setPointerCapture` pattern must be preserved exactly.

**Risk:** LOW — charge labels are well-documented in CLAUDE.md with clear state boundaries.

**Testing strategy:**
1. Show charge labels -> verify HTML overlays render at atom positions
2. Drag a label -> verify offset updates
3. Double-click to edit -> verify input appears, commit on Enter, cancel on Escape
4. Verify labels don't interfere with orbit controls (pointer-events whitelist)

### 3D. Extract `interaction-handlers.ts` (~100 lines, pure functions)

**What moves out:**
- `handle_scene_roll_start`, `handle_scene_roll_move`, `handle_scene_roll_end` (right-drag roll rotation, lines ~1256-1310)
- `handle_keyboard_rotation` (arrow key rotation, already partially inline)
- Context menu dispatch helpers (determining what was right-clicked: atom, bond, void)

**What stays in parent:**
- `$effect` that attaches keyboard/pointer listeners
- `is_right_dragging`, `right_drag_prev_x`, `right_drag_suppress_context` state

**Risk:** LOW — pure event handler functions.

**Testing strategy:**
1. Right-drag on empty canvas -> verify roll rotation
2. Arrow keys -> verify camera rotation
3. Right-click atom -> verify context menu appears with correct target

### 3E. Extract `depth-cue-helpers.ts` (~40 lines, pure functions)

**What moves out:**
- Wireframe depth coloring computation (desaturation based on camera distance)
- Already partially extracted to `scene/render-data.ts` (`desaturate_color`). This item catches any remaining inline depth-cue logic.

**Risk:** LOW

**Testing strategy:** Visual inspection — wireframe bonds should fade with distance.

### Estimated net reduction: ~560 lines (to ~3000)

The remaining ~200 lines to reach ~2800 would come from:
- Camera setup/reset logic extraction (~100 lines)
- Force vector rendering helpers (~50 lines)
- Tooltip formatting extraction (~50 lines)

---

## 4. WorkflowEditor.svelte (3534 lines -> ~2700 target)

**Path:** `src/lib/workflow/WorkflowEditor.svelte`

### 4A. Extract `workflow-canvas-interaction.svelte.ts` (~250 lines)

**What moves out:**
- `drag` state (node dragging)
- `conn` state (connection drawing)
- `mouse`, `pan`, `zoom`, `panning`, `pan_start` state
- `box_sel` state (box selection)
- `get_svg_pt()` coordinate transform helper
- Mouse/touch event handlers: `onmousedown`, `onmousemove`, `onmouseup`, `onwheel`
- Node drag start/move/end
- Connection draw start/move/end
- Box selection start/move/end
- Pan start/move/end
- Zoom handler

**What stays in parent:**
- SVG `<g>` element with event bindings
- `svg_el` state (DOM reference)
- `nodes` and `edges` arrays (passed as deps — the canvas interaction modifies them via callbacks)

**Svelte 5 gotchas:**
- `pan` and `zoom` are read by the SVG transform attribute in the template: `transform="translate({pan.x},{pan.y}) scale({zoom})"`. The extracted module must expose these as reactive state that the template can bind to.
- `drag` start captures a deep copy of `nodes` (line 89 `start: WfNode[]`) for undo. The deep copy must use `JSON.parse(JSON.stringify(...))` to escape Svelte proxies.
- `conn` state renders a temporary SVG line in the template. The factory must expose `conn` as readable `$state`.

**Risk:** MODERATE — canvas interaction is tightly coupled to the SVG template. Many event handlers reference `nodes`, `edges`, `sel_nodes` directly. The extraction must define a clean deps interface with getters/setters for all shared state.

**Testing strategy:**
1. Drag node -> verify snap to grid
2. Draw connection between nodes -> verify edge created
3. Pan canvas -> verify smooth panning
4. Zoom in/out -> verify zoom around cursor
5. Box select -> verify multiple nodes selected
6. Undo after drag -> verify node positions restored

### 4B. Extract `workflow-execution.svelte.ts` (~200 lines)

**What moves out:**
- `sim_running`, `workflow_status`, `execution_error` state
- `show_run_dialog`, `show_pause_dialog`, `pause_jobs` state
- `node_statuses` record
- `handle_run_click()`, `handle_execute()`, `handle_pause_confirm()` functions
- `ensure_slab_gen_structures()` pre-run WASM validation
- WebSocket monitor connection/disconnection logic
- `connect_workflow_monitor()` call and message handling
- Run config validation
- `has_running_jobs` derived

**What stays in parent:**
- RunConfigDialog, PauseDialog component instances
- Template for execution status banners
- `nodes` and `edges` (passed as deps for save-before-run)

**Svelte 5 gotchas:**
- `node_statuses` is a `Record<string, string>` that is updated by WebSocket messages. Svelte 5 tracks property additions/deletions on `$state` objects, so `node_statuses[id] = 'running'` works reactively. This must be preserved (no spread-replace).
- The WebSocket monitor cleanup must happen in the factory's `$effect` cleanup function, not in `onDestroy` (which is component-level).

**Risk:** HIGH — execution involves WebSocket lifecycle, async HPC operations, and race conditions between run-trigger and status-poll. The WebSocket reconnect logic and stale-status handling (documented in CLAUDE.md workflow bugs) is subtle.

**Testing strategy:**
1. Click Run -> verify run config dialog opens
2. Execute workflow -> verify node statuses update via WebSocket
3. Pause running workflow -> verify pause dialog, jobs list
4. Re-run after failure -> verify statuses reset to "pending" (regression test for known bug)
5. Disconnect WebSocket mid-run -> verify reconnect or error handling
6. Run workflow with slab_gen node without preview -> verify WASM pre-generation

### 4C. Extract `workflow-history.svelte.ts` (~60 lines)

**What moves out:**
- `history` array state
- `hist_idx` state
- `push_history()`, `undo()`, `redo()` functions

**What stays in parent:**
- Keyboard shortcut dispatch (Ctrl+Z/Y) that calls `undo()`/`redo()`
- Toolbar buttons that call `undo()`/`redo()`

**Svelte 5 gotchas:**
- `push_history()` uses `JSON.parse(JSON.stringify(nodes))` to deep-clone. This is necessary to escape Svelte proxies. Must be preserved.
- `undo()`/`redo()` directly assign to `nodes` and `edges` — these must be setter functions in the deps interface.

**Risk:** LOW — self-contained undo stack with clear API.

**Testing strategy:**
1. Add node -> undo -> verify removed
2. Redo -> verify restored
3. Add node, add edge, undo twice -> verify both reversed
4. After undo, add new node -> verify redo stack truncated

### 4D. Extract `workflow-clipboard.svelte.ts` (~40 lines)

**What moves out:**
- `clipboard` state
- `copy_selected()`, `paste()`, `delete_selected()` functions

**What stays in parent:**
- Keyboard shortcut dispatch (Ctrl+C/V, Delete)
- Toolbar buttons

**Svelte 5 gotchas:** Deep clone with `JSON.parse(JSON.stringify(...))` — same as history.

**Risk:** LOW

**Testing strategy:**
1. Select nodes -> Ctrl+C -> Ctrl+V -> verify duplicated with offset
2. Delete selected -> verify removal and edge cleanup

### 4E. Extract `workflow-hpc-banner.svelte.ts` (~60 lines)

**What moves out:**
- `needed_hpc_hosts` state and its computation `$derived`
- `hpc_banner_dismissed` state
- `show_connect_dialog` state
- HPC session availability check logic

**What stays in parent:**
- Banner template (the `{#if needed_hpc_hosts.length > 0}` block)
- ConnectDialog component instance

**Risk:** LOW — simple derived + UI state.

**Testing strategy:**
1. Open workflow with HPC nodes but no session -> verify banner appears
2. Dismiss banner -> verify it hides
3. Connect HPC session -> verify banner disappears

### 4F. Extract `workflow-change-detection.svelte.ts` (~60 lines)

**What moves out:**
- `known_updated_at` state
- `external_change_detected` state
- Polling `$effect` that checks `workflow_api.get_workflow()` for external changes
- Reload handler

**What stays in parent:**
- Template for the "external changes detected" banner
- Reload button handler

**Risk:** LOW — isolated polling logic.

**Testing strategy:**
1. Edit workflow from another tab -> verify "external changes" banner appears
2. Click reload -> verify graph updates

### Estimated net reduction: ~670 lines (to ~2864)

The remaining ~164 lines to reach ~2700 would come from:
- VASP editor state extraction (~80 lines of `vasp_*` state variables)
- Structure input dialog state (~50 lines)
- Node config panel state (~30 lines)

---

## 5. Sidebar.svelte (3480 lines -> ~2100 target)

**Path:** `desktop/Sidebar.svelte`

### 5A. Extract `sidebar/hpc-browser.svelte.ts` (~250 lines)

**What moves out:**
- `hpc_current_path`, `hpc_merging_dir`, `hpc_merge_status`, `hpc_merge_timer` state
- `hpc_upload_progress`, `hpc_files_error`, `hpc_file_tree_key`, `hpc_loading_file` state
- `set_hpc_merge_status()` helper
- `read_file_content()`, `read_binary_content()` — file reading abstraction (local vs remote)
- `hpc_load_structure()`, `hpc_load_trajectory()` — structure/trajectory loading from HPC
- `hpc_open_editor()` — open file in Monaco editor
- `hpc_upload()` — file upload with progress
- `hpc_merge_structures()` — merge structures from directory
- `hpc_mkdir_handler()`, `hpc_delete_handler()`, `hpc_rename_handler()`, `hpc_copy_handler()`, `hpc_move_handler()` — file operations
- HPC context menu actions

**What stays in parent:**
- `<FileTree>` component instance and its event binding
- Template for HPC section (session selector, path bar, upload button)
- `hpc_sessions` derived from `hpc_session_store`
- `source` prop (determines which session is active)

**Svelte 5 gotchas:**
- `hpc_current_path` is synced to the `hpc_path` bindable prop via `$effect(() => { hpc_path = hpc_current_path })`. The extracted module must expose `hpc_current_path` as state that the parent bridges to the prop.
- `hpc_merge_timer` is a `setTimeout` handle — not reactive state, just a plain variable. The factory cleanup must clear it.

**Risk:** MODERATE — HPC file operations are async and interact with the backend. Error handling paths are numerous. The `read_file_content` / `read_binary_content` functions have conditional logic for Tauri vs desktop-dev vs remote, which must be preserved exactly.

**Testing strategy:**
1. Browse HPC directory -> verify file list loads
2. Click structure file -> verify it loads in viewer
3. Upload file -> verify progress indicator, file appears in list
4. Right-click -> mkdir, rename, delete -> verify each operation
5. Merge structures from directory -> verify success/error message
6. Switch HPC sessions -> verify path resets

### 5B. Extract `sidebar/fs-browser.svelte.ts` (~250 lines)

**What moves out:**
- `fs_browser_open`, `fs_current_dir`, `fs_items`, `fs_parent` state
- `fs_loading`, `fs_error`, `fs_path_editing`, `fs_path_input` state
- `fs_export_name`, `fs_exporting`, `fs_export_msg` state
- `fs_ctx`, `fs_clipboard`, `fs_renaming`, `fs_rename_val` state
- `fs_delete_confirm`, `fs_new_folder`, `fs_new_folder_name`, `fs_op_loading` state
- `fs_browse()`, `fs_go_up()`, `fs_handle_click()` — directory navigation
- `fs_save_structure()`, `fs_export_here()` — structure export to local FS
- `fs_ctx_*` handlers — context menu operations (copy, cut, paste, rename, delete, new folder)
- Path editing commit/cancel

**What stays in parent:**
- Template for filesystem browser section
- `fs_path` bindable prop bridge
- `on_load_file`, `on_open_editor`, `on_preview_file` callbacks (passed as deps)

**Svelte 5 gotchas:**
- `fs_current_dir` syncs to `fs_path` bindable prop — same pattern as HPC path sync.
- `fs_items` is an array of `FileBrowseItem` objects. Replace-assign (`fs_items = result.items`) is fine for arrays since it's a top-level reassignment, not a spread of the parent.

**Risk:** MODERATE — filesystem operations involve Tauri plugin imports (`@tauri-apps/plugin-fs`) which may not be available in all environments. The fallback paths must be preserved.

**Testing strategy:**
1. Open filesystem browser -> verify directory listing
2. Navigate into subdirectory -> verify breadcrumbs update
3. Click structure file -> verify it loads
4. Click image file -> verify preview opens
5. Right-click -> rename, delete, new folder -> verify each operation
6. Copy/cut/paste file -> verify operation completes
7. Export structure to current directory -> verify file created

### 5C. Extract `sidebar/sidebar-context-menus.ts` (~200 lines, pure functions)

**What moves out:**
- `ctx_menu` state and the shared context menu handler (`handle_ctx_open`, `handle_ctx_close`)
- `ctx_target_snapshot` — captured target for async operations
- All context menu action dispatchers for the localdb section:
  - Project context menu (rename, delete, add workflow)
  - Workflow context menu (open, duplicate, delete, copy to project)
  - Result context menu (view structure, rename, delete, drag to project)
- `ctx_wf_copy_submenu`, `ctx_copy_submenu` state
- `catgo_ctx` state and catgo sample file context menu handlers

**What stays in parent:**
- Context menu template (`{#if ctx_menu}` overlay with positioned `<div>`)
- API call imports (`delete_project`, `update_project`, etc.)

**Svelte 5 gotchas:** None significant — context menu state is simple coordinates + target reference.

**Risk:** LOW — context menus are fire-and-forget UI dispatchers.

**Testing strategy:**
1. Right-click project -> verify correct menu items
2. Right-click workflow -> verify correct menu items
3. Right-click result -> verify correct menu items
4. Rename project via context menu -> verify name updates
5. Delete result -> verify removal from list

### 5D. Extract `sidebar/rename-save-dialogs.svelte.ts` (~100 lines)

**What moves out:**
- `renaming_project_id`, `renaming_result_id`, `rename_value` state
- `saving` state
- `show_save_dialog`, `save_target_project` state
- Rename commit/cancel handlers
- Save-to-project dialog logic (project selection, save execution)

**What stays in parent:**
- Dialog templates
- API call wiring

**Risk:** LOW

**Testing strategy:**
1. Rename project -> verify update persists
2. Rename result -> verify update persists
3. Save structure to project -> verify entry appears in project

### 5E. Extract `sidebar/cwd-sync.svelte.ts` (~60 lines)

**What moves out:**
- BroadcastChannel setup for `catgo-terminal-cwd` (lines 102-120)
- CustomEvent listener for same-window CWD changes
- `prev_source` tracking and source-change handling (lines 126-148)
- CWD sync logic that updates `hpc_current_path` when terminal directory changes

**What stays in parent:**
- `source` prop
- `$effect` that calls the sync module's setup

**Svelte 5 gotchas:**
- The `$effect` cleanup must close the BroadcastChannel and remove both event listeners. Currently this is correctly implemented inline — the extraction must preserve the cleanup return function.

**Risk:** LOW — isolated event listener plumbing.

**Testing strategy:**
1. Open terminal, `cd /tmp` -> verify sidebar path updates
2. Switch HPC sessions -> verify CWD sync restarts for new session
3. Close sidebar -> verify listeners cleaned up (no memory leak)

### Estimated net reduction: ~860 lines (to ~2620)

The remaining ~520 lines to reach ~2100 would come from:
- Database browser state extraction (projects, workflows, results CRUD) (~300 lines)
- File picker dialog state (~100 lines)
- Drag-and-drop logic (~60 lines)
- Section collapse state management (~60 lines)

---

## Execution Order

Recommended order based on risk and dependency:

| Phase | File | Extraction | Risk | Lines Saved |
|-------|------|-----------|------|-------------|
| 1 | WorkflowEditor | 4C history + 4D clipboard | LOW | ~100 |
| 1 | WorkflowEditor | 4E HPC banner + 4F change detection | LOW | ~120 |
| 1 | Sidebar | 5C context menus + 5D dialogs + 5E CWD sync | LOW | ~360 |
| 2 | Structure | 1B charge labels + 1C measurements | LOW | ~220 |
| 2 | StructureScene | 3D interaction handlers + 3E depth cue | LOW | ~140 |
| 2 | App | 2B close-all + 2C keyboard | LOW | ~140 |
| 3 | StructureScene | 3A GPU picker + 3C charge rendering | MOD | ~220 |
| 3 | App | 2A tab manager | MOD | ~180 |
| 3 | Structure | 1A selection state | MOD | ~200 |
| 3 | Sidebar | 5A HPC browser + 5B FS browser | MOD | ~500 |
| 4 | WorkflowEditor | 4A canvas interaction | MOD | ~250 |
| 4 | StructureScene | 3B bond computation | HIGH | ~200 |
| 4 | WorkflowEditor | 4B execution | HIGH | ~200 |

**Phase 1** (LOW risk, ~580 lines): Safe extractions that establish the pattern. Can be done in a single session with confidence.

**Phase 2** (LOW risk, ~500 lines): More extractions following the established pattern. Slightly more integration points but still low-risk.

**Phase 3** (MODERATE risk, ~1100 lines): Extractions that touch core state management. Each should be done individually with thorough testing before moving to the next.

**Phase 4** (HIGH risk, ~650 lines): Complex extractions with async/reactive subtlety. Each needs dedicated review and testing.

---

## Validation Checklist (per extraction)

- [ ] `pnpm check` passes (TypeScript / Svelte)
- [ ] No new runtime console errors
- [ ] All interactive features of the affected component work as before
- [ ] No infinite-loop `$effect` regressions (check for `effect_update_depth_exceeded`)
- [ ] Async operations complete correctly (WASM, Workers, WebSocket, API calls)
- [ ] Generation counters prevent stale async results
- [ ] `SvelteMap` used where `$derived` needs to track Map mutations
- [ ] No spread-replace of deeply nested `$state` objects
- [ ] Cleanup functions in `$effect` returns properly dispose listeners/timers/channels
- [ ] GPU picker threshold (2000 atoms) remains accessible and correct
- [ ] WASM async race conditions use generation counters

---

## Summary

| Component | Current | Target | Reduction | Extractions |
|-----------|---------|--------|-----------|-------------|
| Structure.svelte | 5142 | ~4550 | ~590 | 4 modules |
| App.svelte | 3603 | ~3280 | ~320 | 3 modules |
| StructureScene.svelte | 3560 | ~3000 | ~560 | 5 modules |
| WorkflowEditor.svelte | 3534 | ~2864 | ~670 | 6 modules |
| Sidebar.svelte | 3480 | ~2620 | ~860 | 5 modules |
| **Total** | **19,319** | **~16,314** | **~3,000** | **23 modules** |

Conservative estimates. Actual reductions will depend on how much boilerplate the factory/deps interfaces add. The 23 extraction modules will be a mix of `.svelte.ts` (for reactive state) and `.ts` (for pure functions).
