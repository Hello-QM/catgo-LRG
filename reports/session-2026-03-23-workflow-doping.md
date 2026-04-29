# Session Report: Workflow Tab, Doping Tool & UX Improvements (2026-03-23)

## Overview
Major enhancements to the workflow system, doping tool, and overall UX. Built new components, fixed data routing bugs, and improved the material design pipeline.

---

## 1. Workflow Overlay Panel (`WorkflowPane.svelte`)

### New file: `src/lib/structure/WorkflowPane.svelte` (rewritten)
- **"New Workflow with Structure"** button — creates workflow with current viewer structure via `GET /view/structure/current`
- **"Send Structure to This Workflow"** — updates existing workflow's structure_input node
- **Delete workflows** — per-workflow delete with confirmation
- **Open Editor** — navigates to full workflow editor
- **Boxed sections** — New / Current / Previous visually separated
- Structure fetched from backend API (authoritative), not Svelte prop (was returning wrong structure)

### Wiring: `Structure.svelte` + `App.svelte`
- Added `on_open_workflow_editor` prop to Structure.svelte
- App.svelte passes `handle_sidebar_open_workflow` callback
- Passes `saveable_structure ?? structure` to WorkflowPane

---

## 2. Workflow Status & Results Display

### `NodeStatusPanel.svelte` fixes
- **`is_mlp` detection** — unified calc types (`geo_opt` with `software=mlp`) now correctly identified as MLP
- **MLP results section** — energy (green highlight), work dir, output log, output files (CONTCAR download, output.log download, View Structure button)
- **View Structure** — parses embedded CONTCAR inline, pushes to viewer via `/view/structure/pending-update` (no HPC needed)
- **CachedSummary** — added `contcar`, `stdout`, `work_dir` fields
- **Status panel visual refresh** — blue section headers, card-style info rows, styled output log toggle

### `WorkflowEditor.svelte` — View Output Structure fix
- Added `result.contcar` parsing path in `open_structure_edit_3d()` for MLP nodes
- MLP engines store optimized structure as CONTCAR (POSCAR format), not `result.structure` (JSON)

---

## 3. Data Routing Fixes

### `src/lib/api/workflow.ts` — `list_steps()` reordered
- **Before**: tried WASM DB first, fell back to HTTP. WASM had step rows but NO execution results (result_json, timestamps)
- **After**: tries HTTP first (has execution data), falls back to WASM only when backend unreachable
- Returns HTTP result even if empty (removed `length > 0` check)

### `server/workflow/engine.py` — Orphan scan fix
- Checks `result_json` before marking step as failed
- If step has results → mark completed (not failed)
- If no HPC session and no HPC job → local execution error message (not HPC error)
- Distinguishes local vs HPC failures

---

## 4. StructureInputDialog Enhancement
### `src/lib/workflow/StructureInputDialog.svelte`
- **"Capture from Viewer"** button — fetches current structure from `GET /view/structure/current`
- Appears above the tab bar in non-view mode

---

## 5. Workflow Editor Toolbar
### `WorkflowEditor.svelte`
- Changed toolbar from `flex-wrap: nowrap` (scrolling) to `flex-wrap: wrap` (wrapping into rows)

---

## 6. NodeConfigPanel Improvements
### `src/lib/workflow/NodeConfigPanel.svelte`
- **`periodic` type renderer** — text input + clickable element chip bar (18 common elements)
- **`doping_groups` type renderer** — multi-group substitution editor with target/replacement element management
- **Progressive disclosure** — groups auto-collapse except essential ones (Software, General, Model, Doping)
- **Modification indicators** — amber dot on collapsed groups with modified values
- **Groups reset** on node switch

---

## 7. Doping Node Definition
### `src/lib/workflow/node-defs/utility/doping-gen.ts`
- Added `mode` param: Simple (one dopant) | Combinatorial (multi-group)
- Added `target_indices` param for specific site selection
- Added `groups` param (JSON string) for combinatorial mode
- Added `combo_max_configs` for combinatorial max (avoids key collision with simple mode's `max_configs`)

---

## 8. Doping Sidebar Discoverability
### `src/lib/workflow/node-defs/index.ts`
- New `STANDALONE_TOOL_TYPES` set: `slab_gen`, `doping_gen`, `adsorbate_place`
- New **"Build"** sidebar category with individual drag targets for the 3 most-used tools
- Remaining polymer/specialized tools stay under merged "Tools" entry

---

## 9. Backend Doping Enhancements
### `server/routers/build.py`
- `/build/doping` endpoint accepts `target_indices: Optional[list[int]]`
- When provided, dopes exactly those sites (overrides element-based auto-detection)
- Enumerate works with specific indices (combinatorial of selected sites)
- Max configs raised from 50 to 500

### `server/workflow/engines/local.py`
- `doping_gen` node supports `mode: "combinatorial"` — routes to `/build/substitution`
- Parses `target_indices` from comma-separated string or list
- Empty groups guard — throws clear error instead of silent failure
- Uses `combo_max_configs` for combinatorial mode

---

## 10. Dedicated Doping Workflow Modal
### NEW: `src/lib/workflow/components/DopingWorkflowModal.svelte`
- **Fullscreen side-by-side layout** — left panel (420px) + right 3D viewer
- **Left panel**:
  - Sticky periodic table (PeriodicTable component) — click elements to toggle dopants
  - Collapsible groups — inactive groups show one-line summary, active group expands
  - Config (max structures, total count)
  - Variants list (blue-themed, scrollable, max 280px) — click to switch 3D viewer
- **Right panel**: 3D Structure viewer with atom selection
- **Variant browsing** — generated structures appear as selectable list, clicking updates viewer
- **"Generate N Structures"** button in header
- **"Save All N & Close"** — saves as trajectory to workflow node

### Doping node properties panel simplified
- Hides NodeConfigPanel for `doping_gen` nodes
- Shows only: "Open Doping Editor" + "Screen All Sites" buttons + config summary
- Summary shows: dopant, host, mode, groups (read-only)

---

## 11. Screening Pipeline Template
### `src/lib/workflow/graph-model.ts`
- New `doped_catalyst_screening` template:
  - Structure Input → Slab Gen → Doping Gen (enumerate, 20 configs) → Geo Opt (MACE) → Energy Compare
- Added to "Surface Catalysis" template group

---

## 12. ParamDef Type Extension
### `src/lib/workflow/workflow-types.ts`
- Added `'doping_groups'` to ParamDef `type` union

---

## Files Modified (summary)

| File | Change Type |
|------|-------------|
| `src/lib/structure/WorkflowPane.svelte` | Rewritten |
| `src/lib/structure/Structure.svelte` | Props + wiring |
| `src/lib/structure/DopingPane.svelte` | Inline PT + min-width |
| `desktop/App.svelte` | Callback wiring |
| `src/lib/workflow/WorkflowEditor.svelte` | Doping buttons, modal, toolbar, simplified panel |
| `src/lib/workflow/NodeConfigPanel.svelte` | periodic/doping_groups renderers, progressive disclosure |
| `src/lib/workflow/NodeStatusPanel.svelte` | is_mlp fix, MLP results, output files, View Structure |
| `src/lib/workflow/StructureInputDialog.svelte` | Capture from Viewer |
| `src/lib/workflow/components/StructureEditModal.svelte` | initial_panel prop |
| `src/lib/workflow/components/DopingWorkflowModal.svelte` | **NEW** — dedicated doping editor |
| `src/lib/workflow/node-defs/index.ts` | Build category, STANDALONE_TOOL_TYPES |
| `src/lib/workflow/node-defs/utility/doping-gen.ts` | mode, target_indices, groups params |
| `src/lib/workflow/workflow-types.ts` | doping_groups type |
| `src/lib/workflow/graph-model.ts` | Screening template |
| `src/lib/api/workflow.ts` | list_steps HTTP-first |
| `server/workflow/engine.py` | Orphan scan fix |
| `server/workflow/engines/local.py` | Combinatorial doping, target_indices |
| `server/routers/build.py` | target_indices support |

---

## Known Issues / Follow-ups
- Periodic table in DopingPane (standalone Build Tools) still has the inline PeriodicTable + original DopingPTPanel window — both coexist
- DopingWorkflowModal doesn't save selected indices back to node params yet (uses combinatorial_substitution API directly)
- "Screen All Sites" button sets params but doesn't auto-run
- Structure layers/variants system for non-doping use cases (Photoshop-like) — deferred to future session
