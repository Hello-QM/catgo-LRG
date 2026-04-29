# Refactor Hotspots Report

Date: 2026-03-13

Last updated: 2026-03-13

Scope:

- code areas that were unusually large or overloaded
- refactor actions taken in this session

## Highest-Priority Frontend Hotspots

### `src/lib/structure/Structure.svelte`

Status: refactored (5480 → 5098 lines)

What changed:

- extracted `controllers/transform-controller.ts` (134 lines) — PBC image helpers, import positioning, charge application
- extracted `controllers/analysis-controller.ts` (110 lines) — measurement CRUD, charge queries, element uniqueness
- extracted `controllers/viewer-controller.ts` (161 lines) — context menu builders, bond edit validation
- Structure.svelte remains the orchestrator; controllers join pre-existing ones in `controllers/`

### `src/lib/structure/ExportPane.svelte`

Status: refactored (4985 → 3640 lines)

What changed:

- extracted `export/common-export.ts` (151 lines) — magmom DB, atomic masses, shared helpers
- extracted `export/qe-export.ts` (73 lines)
- extracted `export/lammps-export.ts` (184 lines)
- extracted `export/gaussian-export.ts` (76 lines)
- extracted `export/gromacs-export.ts` (309 lines)
- extracted `export/orca-export.ts` (120 lines)
- extracted `export/abacus-export.ts` (154 lines)
- extracted `export/cp2k-export.ts` (739 lines)
- ExportPane.svelte keeps UI state, reactive blocks, and server-call orchestration

### `src/lib/structure/StructureScene.svelte`

Status: refactored (3534 → 3379 lines)

What changed:

- extracted `scene/visibility.ts` (181 lines) — bond/atom/lattice visibility rules
- extracted `scene/picking.ts` (91 lines) — selection toggle, hover guards, highlight entries
- extracted `scene/render-data.ts` (175 lines) — desaturate, fingerprints, force data, majority element
- StructureScene.svelte keeps Threlte template, $effect/$derived wiring, camera/controls

### `src/lib/workflow/WorkflowEditor.svelte`

Status: refactored (3013 → 2482 lines)

What changed:

- extracted `graph-model.ts` (559 lines) — types, constants, geometry, DAG validation, layout, copy/paste, serialization, templates
- extracted `workflow-commands.ts` (112 lines) — chat action handler factory with WorkflowCommandState interface
- WorkflowEditor.svelte keeps reactive state, UI gestures, dialog management

### `src/lib/chat/ChatPane.svelte`

Status: refactored (2698 → 2458 lines)

What changed:

- extracted `message-utils.ts` (190 lines) — model data, formatting, error helpers
- extracted `tool-execution.ts` (35 lines) — tool result filtering, streaming detection
- extracted `attachment-utils.ts` (62 lines) — clipboard, code-block delegation

## Highest-Priority Backend Hotspots

### `server/mcp_tools/server.py`

Status: refactored (1555 → 373 lines)

What changed:

- extracted `helpers.py` (106 lines) — API_BASE, structure push, matrix math
- extracted `workflow_tools.py` (589 lines) — all workflow action handling, graph validation
- extracted `structure_tools.py` (439 lines) — OPTIMADE/PubChem conversion, crystal/molecule fetch
- extracted `plugin_tools.py` (143 lines) — plugin manager, analyzer/reader handlers
- server.py is now a thin dispatch layer

### `server/routers/workflow.py`

Status: refactored (1904 → 1592 lines)

What changed:

- extracted `services/workflow_service.py` (202 lines) — site metadata, param coercion, ASE serialization, path validation
- extracted `services/workflow_results.py` (178 lines) — convergence expansion, frequency fetching, result building
- router keeps thin HTTP handlers

### Tool lifecycle

Status: resolved (2026-03-13)

- deleted `server/plugins/tool_builder.py` and `server/test_self_extending.py`
- `server/tools/builder.py` is the single canonical tool lifecycle

### `src-tauri/src/db.rs`

Status: refactored (2480 lines → 5-file module)

What changed:

- split into `db/mod.rs` (396), `db/util.rs` (204), `db/workflow.rs` (1060), `db/results.rs` (598), `db/files.rs` (280)
- lib.rs updated with sub-module paths

## Secondary Hotspots (not yet refactored)

- `src/lib/structure/parse.ts` (~3079 lines)
- `src/lib/workflow/node-definitions.ts` (~2544 lines)
- `src/lib/structure/ServerPane.svelte` (~2437 lines)
- `desktop/App.svelte` (~3914 lines)
- `desktop/Sidebar.svelte` (~3469 lines)
- `src/lib/trajectory/Trajectory.svelte` (~1925 lines)
- `src/lib/trajectory/parse.ts` (~1745 lines)
- `src/lib/settings.ts` (large and configuration-heavy)

## Verification

- `pnpm check`: 0 errors, 263 warnings (all pre-existing)
- `cargo check` (src-tauri): compiles clean, 0 errors, 0 warnings
- Python imports: all server modules import correctly
