# CatGo Repository Guide

This file is a conservative, current snapshot of the repository. It intentionally avoids brittle details like exact line counts and exact command totals.

Status note:

- treat this file as a repository map, not a bug ledger
- current bug status should live in `reports/bug-*.md` and `WORKFLOW_BUGS.md`
- if a historical note elsewhere conflicts with these status-tracked reports, trust the status-tracked reports first

## What CatGo Is

CatGo is a materials-science toolkit with three closely related runtime surfaces:

- Web app: SvelteKit + Svelte 5 runes
- Desktop dev shell: standalone Vite frontend
- Tauri desktop app: Rust shell + Python backend

The project combines:
- interactive structure / trajectory / spectroscopy UI
- Python backend APIs for heavy scientific logic
- Rust / WASM acceleration for selected geometry and bonding operations
- AI-facing tools for chat and MCP workflows

## High-Level Layout

- `src/`
  - Main frontend app
  - `src/lib/structure/` is the core 3D structure viewer stack
  - `src/lib/workflow/` is the workflow editor and project dashboard UI
  - `src/lib/chat/` is the in-app AI tool loop
- `server/`
  - FastAPI backend
  - workflow, analysis, structure, HPC, MCP, and tool-routing endpoints
- `desktop/`
  - standalone desktop frontend shell used outside full Tauri packaging
- `src-tauri/`
  - Rust Tauri backend
  - local SQLite, PTY, file-open integration, command registration
- `extensions/`
  - Rust/WASM and analysis extensions

## Development Commands

- `pnpm dev`
  - Web frontend dev server
  - Default port is `3000 + worktree_offset`
- `pnpm desktop:dev`
  - Standalone desktop frontend
  - Default port is `3100 + worktree_offset`
- `pnpm desktop:serve`
  - Standalone desktop frontend + Python backend together
  - **Note:** `desktop:serve` uses `/opt/anaconda3/bin/python` explicitly — the system `python` points to a broken venv on this machine
- `pnpm tauri:dev`
  - Full Tauri desktop app
- `pnpm check`
  - Svelte / TypeScript check
  - Note: the repo currently emits a tsconfig warning because the root `tsconfig.json` does not extend `.svelte-kit/tsconfig.json`

## Current Architectural Facts

- Web and desktop frontend builds are different:
  - web uses SvelteKit
  - desktop frontend uses standalone Vite config plus mocks for `$app/*`
- Workflow operations have two AI-facing layers:
  - frontend chat workflow tools in `src/lib/chat/workflow-tools.ts`
  - MCP `catgo_workflow` in `server/mcp_tools/server.py`
- The MCP workflow path is not identical to the frontend chat path.
- Project-based workflow ownership is the active model.
  - legacy workflow-folder code still exists for compatibility but is not the preferred UI path

## Recent Changes

### [2026-04-19] Tauri Desktop Startup Fixes

**Location:** `package.json`, `src-tauri/src/db/mod.rs`, `src/lib/workflow/WorkflowEditor.svelte`

**Problems Fixed:**

1. **Python backend failed to start** — `desktop:serve` used bare `python` which pointed to a broken venv. Fixed by using `/opt/anaconda3/bin/python` explicitly in `package.json`.

2. **"no such table: workflows/projects" on workflow create** — The Rust `get_conn()` function opened the SQLite DB but never called `ensure_tables()`, so tables were missing on first run. Fixed by calling `ensure_tables(&conn)?` inside `get_conn()` so every connection initializes the schema.

3. **Palette node drag-and-drop broken in Tauri/macOS** — HTML5 `ondrop` events don't fire reliably in Tauri's macOS WebView for same-window drags. Replaced drag-and-drop with a pointer-event based system: `onpointerdown` starts the drag, a ghost element follows the cursor, and `onpointerup` drops the node at the release position.

### [2026-04-17] Packmol — Mixtures and Correct Single-Species Packing (MD Minimize)

**Location:** `server/workflow/engines/lammps.py`, `src/lib/workflow/node-defs/calculation/md-minimize.ts`, `server/catgo/workflow/engine/submitter.py`, `server/catgo/workflow/engine/batch_submitter.py`, `server/catgo/workflow/graph_converter.py`

**Problem:** The LAMMPS Packmol pre-step used non-Packmol keywords and never uploaded a template PDB, so packing failed or behaved unpredictably. It assumed a rough average mass, ignored the workflow structure input for single-species packing, and had no way to build multi-component boxes (e.g. water + ethanol at specified counts).

**Fix:**
- Emit valid Packmol input (`filetype pdb`, `structure` / `number` / `inside box` / `end structure`); compute cubic box edge from target density and summed stoichiometric mass.
- **Mixture mode:** parameter `packmol_components` — JSON array of `{ "count": N, "smiles": "..." }`; each SMILES is converted to a template PDB with Open Babel (`obabel`) on the CatGo server before files are sent to HPC.
- **Mixture from uploaded structures:** connect **several Structure Input** nodes to the **same** `structure` port (`in-0`). The resolver collects them as an ordered list; Packmol uses **`packmol_file_counts`** `[N0, N1, …]` or **`packmol_components`** with `"input": "structure"` and `"template_index": 0, 1, …`. Other engines still receive the **first** template only (`primary_structure_input` in submitter / advancer). `restart` remains `in-1`. `_resolved_workflow_inputs` still carries the full dict for LAMMPS.
- **Single-species mode:** leave mixture JSON empty; use the connected structure as the template and `packmol_n_molecules`.
- Parse Packmol output into a periodic pymatgen structure (orthorhombic cell matching the box); use `as_dict()` for serialization.
- **Local** LAMMPS runs (`execute_lammps_local`) call the same Packmol builder when `packmol_enabled` is set (non–polymer nodes).
- **Heterogeneous file formats → LAMMPS data:** `load_structure_for_lammps()` / `_structure_input_to_pdb_string()` accept CatGo JSON (with optional `_mol2_content`, `_xyz_content`, `_pdb_content`, or `file_content` + `file_format`), raw MOL2/XYZ/PDB/CIF/POSCAR text, or pymatgen `sites` dicts. Open Babel (`obabel`) is used when pymatgen line parsers are insufficient. Packmol output JSON embeds `_pdb_content` so **Use Force Field** can call `/api/forcefield/convert` and write `system.data`; non–force-field paths use the same loader for `generate_data_file`.
- UI: optional `packmol_tolerance` (Å); help text documents mixture JSON, file counts, and ports.

### [2026-03-30] Fix LAMMPS Preview Modal — Missing Import + Full-Screen Editor

**Location:** `src/lib/workflow/WorkflowEditor.svelte`, `src/lib/workflow/components/InputEditorModal.svelte`

**Problem 1 — Modal stuck on "Generating":** Clicking "Preview in.lammps" on a Molecular Dynamics node opened a modal permanently stuck on "Generating in.lammps..." — the Monaco editor never appeared despite the backend API returning a valid LAMMPS input script (HTTP 200).

**Root Cause:** `MonacoEditorPanel` was used in the template but never imported. Svelte threw `MonacoEditorPanel is not defined` when trying to render the editor, silently crashing the render pass and leaving the UI in the loading state.

**Problem 2 — Tiny unstyled modal:** The LAMMPS/ORCA/CP2K input editor used inline HTML in `WorkflowEditor.svelte` with CSS class names (`vasp-modal-overlay`, `vasp-modal`, etc.) that were scoped inside other component files. Without matching styles, the modal rendered as a tiny unstyled element at the bottom of the screen instead of a proper centered window like VASP's editor.

**Fix:**
1. Replaced inline HTML with the `InputEditorModal` component, which has proper `position: fixed` centered modal styling (900×700px, dark overlay, matching VASP editor UX)
2. Updated `InputEditorModal.svelte` to support `open_count` prop (fresh Monaco on each open) and `onchange` callback (live content tracking)
3. Removed the now-unused direct `MonacoEditorPanel` import from `WorkflowEditor.svelte` (the component handles it internally)

### [2026-03-30] MD Minimize Node

**Location:** Frontend (`src/lib/workflow/node-defs/calculation/md-minimize.ts`, `node-definitions.ts`, `node-defs/index.ts`, `graph-model.ts`, `WorkflowEditor.svelte`, `MonacoEditorPanel.svelte`) and Backend (`server/catgo/routers/workflow.py`, `server/workflow/engines/lammps.py`, `server/workflow/node_sets.py`)

**What Changed:**
- Added a new `md_minimize` unified calculation type for energy minimization using MD engines (LAMMPS, GROMACS, AMBER, MLP)

**Frontend — New Node Definition (`md-minimize.ts`):**
- Inputs: `structure`, `restart` (matches MD node)
- Outputs: `trajectory`, `energy`, `log`, `restart` (matches MD node)
- LAMMPS params: `min_style` (cg/sd/hftn/fire/quickmin), `etol`, `ftol`, `maxiter`, `maxeval`, force field support, pair_style/pair_coeff
- GROMACS params: `integrator` (steep/cg/l-bfgs), `nsteps`, `emtol`, `emstep`, `coulombtype`, cutoffs
- AMBER params: `maxcyc`, `ncyc`, `drms`, PBC, ML/MM potential support
- MLP params: `optimizer` (FIRE/BFGS/LBFGS), `fmax`, `max_steps`, `relax_cell`

**Frontend — Registration:**
- Added `md_minimize` to `UNIFIED_CALC_TYPES`, `CALC_TYPE_OPTIONS`, and `NODE_DEFINITIONS` in both `node-definitions.ts` (legacy monolithic) and `node-defs/index.ts` (modular)
- Added `md_minimize` to `UNIFIED_CALC_TYPES` in `graph-model.ts` so LAMMPS preview button appears

**Frontend — Calc Type Switching Fix (`WorkflowEditor.svelte`):**
- `change_calc_type` now validates preserved `software` parameter against the new node's `param_schema` options; clears it if incompatible (e.g. switching from VASP-only node to md_minimize which has no VASP option)

**Frontend — Preview Timeout Fix (`WorkflowEditor.svelte`):**
- Added `AbortSignal.timeout(15000)` to the `fetch` call for `/workflow/preview-input`
- Enhanced error handling: specific messages for timeout, connection failure, and generic errors

**Frontend — Monaco Editor Live Content (`MonacoEditorPanel.svelte`):**
- Added `onchange` callback that fires on every content change so parent can track live editor text

**Backend — Node Sets (`node_sets.py`):**
- Added `md_minimize` to `UNIFIED_CALC_NODES`
- Added `_resolve_software` mappings: `md_minimize` + `lammps` -> `lammps_minimize`, + `gromacs` -> `gromacs_minimize`, + `amber` -> `amber_minimize`, + `mlp` -> `mlp_relax`
- Added `lammps_minimize` to `LAMMPS_NODES`, `gromacs_minimize` to `GROMACS_NODES`

**Backend — LAMMPS Preview (`workflow.py` - `_preview_lammps_input`):**
- Detects `md_minimize`/`lammps_minimize` node types as minimization (in addition to legacy `ensemble.startswith("minimize_")`)
- Routes `potential_type` to `"forcefield"` or `"custom"` for minimize nodes that don't set it explicitly
- Generates `min_style` + `minimize` commands instead of `velocity`/`fix`/`run` for minimization path

**Backend — LAMMPS Engine (`lammps.py`):**
- `generate_lammps_input_files`: Same `is_minimize` detection and `minimize_kwargs` extraction as preview; passes kwargs to `LammpsInputRequest`
- `_generate_lammps_with_forcefield`: Added minimization branch (`is_ff_minimize`) that outputs `min_style`/`minimize` commands instead of ensemble dynamics
- `execute_lammps_local`: Both code paths (custom data file and structure-based) now detect minimize nodes, set `simulation_type="minimize"`, and pass `min_style`/`etol`/`ftol`/`maxiter`/`maxeval`

### [2026-03-18] Unified LAMMPS Potential/Force Field System

**Location:** `src/lib/workflow/node-definitions.ts`, `server/workflow/engines/lammps.py`

**What Changed:**
- Unified force field and potential selection into single `potential_type` parameter
- Replaced `use_forcefield` checkbox + text `pair_style` with structured dropdown options

**New `potential_type` Options:**
1. **Force Field** - GAFF2/OPLS-AA/COMPASS for molecules (auto-generates bonds/angles/charges)
2. **Lennard-Jones** - Configurable cutoff, epsilon, sigma
3. **CHARMM** - With Coulomb long-range (auto-enables PPPM kspace)
4. **Buckingham** - With A, ρ, C coefficients
5. **EAM (alloy)** - For metals (file or element selection)
6. **Tersoff** - For covalent materials (requires potential file)
7. **Custom** - Manual pair_style/pair_coeff specification

**Conditional Parameter Visibility:**
- **Force field mode**: Hides all pair_style and molecular interaction options (auto-generated)
- **Non-force field modes**: Shows bond_style, bond_coeff, angle_style, angle_coeff, dihedral_style, dihedral_coeff for manual configuration

**Backend Changes:**
- `generate_lammps_inputs()` handles `potential_type` parameter
- Auto-generates correct `pair_style`/`pair_coeff` based on selection
- Auto-enables `kspace_style` for CHARMM potential
- Maintains backward compatibility with legacy `pair_style`/`pair_coeff` direct parameters

### [2026-03-18] Open Babel Integration

**Location:** System-level via Homebrew + Python bindings

**What Changed:**
- Installed Open Babel C++ library (`brew install open-babel`)
- Built Python bindings from source with SWIG
- Force field conversion now fully functional

**Features Enabled:**
- GAFF2/OPLS-AA force field assignment for organic molecules
- Gasteiger and AM1-BCC charge calculation methods
- Molecular format conversion (PDB, MOL2, XYZ to LAMMPS data files)
- Water model solvation (TIP3P, TIP4P, SPC/E)

### [2026-03-18] Canonical Force Field Settings

**Location:** `server/routers/forcefield_utils.py`, `server/workflow/engines/lammps.py`

**What Changed:**
- `server/routers/forcefield_utils.py`: Added canonical `FORCE_FIELD_SETTINGS` dictionary and `get_ff_settings()` helper
- Both Open Babel code paths (`_convert_with_openbabel_cli` and `_convert_with_openbabel`) now use this dictionary instead of hardcoded/incomplete settings
- `server/workflow/engines/lammps.py`: `_generate_lammps_with_forcefield` now imports `get_ff_settings` and uses the selected force field name (not hardcoded amber) for `special_bonds`, `pair_style`, `kspace_style`, etc.

**Benefits:**
- Single source of truth for force field parameters
- Consistent behavior across all force field operations
- Easier to add new force fields with proper settings
- Eliminates hardcoded values scattered across codebase

**OPLS-AA Specific Settings:**
- `pair_style: lj/charmm/coul/long 10.0 12.0` - CHARMM-style LJ with switching function (inner cutoff 10.0 Å, outer cutoff 12.0 Å) for smooth truncation and long-range Coulomb handling
- `pair_modify mix geometric` - OPLS-AA requires geometric combining rules (ε_ij = sqrt(ε_i * ε_j)), not LAMMPS default arithmetic mixing
- `improper_style cvff` - Correct improper style for OPLS-AA (not harmonic)

**Moltemplate Integration:**
- The `include ../system.in.settings` and `include ../system.in.charges` lines are generated when using the antechamber+moltemplate path
- Moltemplate generates these files and the init file reads directly from `system.in.init`, so those includes are already present in moltemplate-generated workflows

**Code Refactoring:**
- Added `_build_ff_init_lines()` helper function to reduce code duplication between CLI and Python Open Babel conversion paths
- Added `pair_modify` support to LAMMPS workflow engine for proper mixing rule configuration

**Bug Fixes:**
- GAFF/GAFF2: Added `pair_modify mix arithmetic` (AMBER uses Lorentz-Berthelot combining rules, was empty)
- GAFF: Fixed `dihedral_style` from `charmm` to `fourier` (same as GAFF2)
- `_build_ff_init_lines`: Fixed command order to match LAMMPS convention - bond/angle/dihedral/improper first, then pair_style/pair_modify, then kspace_style
- `lammps.py`: Moved `special_bonds` before `read_data` (was after, which is a LAMMPS error)
- **Ensemble Command Fix**: Fix command now properly uses ensemble parameter instead of hardcoded nvt:
  - `nve` → `fix 1 all nve`
  - `nvt` → `fix 1 all nvt temp T T 100.0`
  - `npt` → `fix 1 all npt temp T T 100.0 iso P P 1000.0`
- **Thermo Frequency Fix**: Now uses user's `thermo_freq` param (falls back to `dump_freq`) instead of hardcoded 100
- **Velocity Dump Enhancement**: Dump now includes `vx vy vz` so velocities are saved for restart/analysis

### [2026-03-18] Vite SSR Crash Fix and Workflow Parameter Visibility

**Location:** `src/routes/+layout.ts`, `src/lib/workflow/node-definitions.ts`, `src/lib/workflow/workflow-types.ts`, `src/lib/workflow/NodeConfigPanel.svelte`, `src/lib/workflow/node-defs/common.ts`

**What Changed:**

**Vite SSR Crash Fix:**
- Added `ssr = false` to `src/routes/+layout.ts`
- App now runs as proper SPA to prevent "module runner has been closed" crash
- Changes made to correct file (`node-definitions.ts`, not `node-defs/calculation.ts`)

**LAMMPS MD Node Parameter Visibility:**
- Two clean paths for LAMMPS configuration:
  - **Force Field path**: Select Force Field (GAFF2/OPLS-AA) → Force Field and Charge Method appear; bond/angle/pair auto-handled by server
  - **Manual path**: Select other types (LJ, CHARMM, Custom) → Pair/Bond/Angle/Dihedral Style/Coeff appear as free-text fields
- Extra Commands textarea always visible in its own Extra group
- Bond/Angle/Dihedral styles changed from locked dropdowns to free text for any LAMMPS style name

**Show If Condition System:**
- `workflow-types.ts`: Added `ShowIfCondition` interface; `show_if` on `ParamDef` now accepts single condition or array for AND-logic
- `node-defs/common.ts` and `node-definitions.ts`: Replaced 9 `*_only()`/`sella_show()` helpers with shared `with_software()` that merges conditions instead of overwriting
- Fixed 11 LAMMPS params that incorrectly referenced `key: 'Molecular interactions'` (group label) → now correctly reference `key: 'potential_type'`

**NodeConfigPanel.svelte Updates:**
- `is_param_visible` handles both single and array `show_if`, requiring all conditions to pass
- `get_filtered_options` generalized: filters software by `system_type` and any option with its own `show_if`
- Defaults `$effect` extended to reset visible select params whose current value is no longer in filtered options (handles stale values after controlling param changes)

### [2026-03-19] LAMMPS Preview Input Function Fix

**Location:** `src/lib/workflow/WorkflowEditor.svelte`, `src/lib/structure/MonacoEditorPanel.svelte`, `server/routers/workflow.py`

**Problem:** Clicking "Preview in.lammps" button showed a blank Monaco editor instead of the generated LAMMPS input script.

**Root Causes:**
1. **Monaco Editor State Issue:** `MonacoEditorPanel` component only initialized its editor value once during creation. When `input_editor_content` was updated after the async API call completed, the editor value never changed because there was no reactive effect watching the `content` prop.
2. **Stale Content:** `input_editor_content` was never reset when opening the editor, so previous content could bleed into subsequent opens.
3. **Svelte Key Issue:** The `{#key input_editor_filename}` directive only considered the filename, which was the same for all LAMMPS nodes. Svelte reused the component instance instead of recreating it with fresh content.
4. **API URL Issue:** Desktop mode used relative URL `/api/workflow/preview-input` which resolved to port 3100 (Vite dev server) instead of port 8000 (Python backend), causing 404 errors.
5. **Backend Function Issues:** The `_preview_lammps_input` function had multiple issues with command ordering, missing parameters, and incorrect LAMMPS syntax.

**Frontend Fixes (`WorkflowEditor.svelte`):**
- Added `input_editor_open_count` state counter that increments on every `open_input_editor()` call
- Reset `input_editor_content = ''` at the start of each open to prevent stale content
- Changed `{#key input_editor_filename}` to `{#key \`${input_editor_filename}-${input_editor_open_count}\`}` so Monaco is always destroyed and recreated fresh with the correct content
- Replaced `data.content || fallback` check with explicit `c.trim().length === 0` guard that surfaces an informative multi-line comment (including `node.type` and `potential_type`) instead of a blank editor
- Fixed API URL: changed from `/api/workflow/preview-input` to `${API_BASE}/workflow/preview-input` to properly route to the Python backend

**Frontend Fixes (`MonacoEditorPanel.svelte`):**
- Added reactive `$effect()` that watches for changes to the `content` prop and updates the editor value using `editor_instance.setValue()`
- Added `is_programmatic_change` flag to prevent marking programmatic content updates as "dirty" (user edits)
- The editor now correctly displays content when it arrives after async API calls

**Backend Fixes (`workflow.py` - `_preview_lammps_input` function):**
1. **Forcefield path:** Now imports and calls `get_ff_settings(forcefield)` to use canonical force field parameters instead of emitting placeholder comments
2. **Param key fix:** Changed from `params.get("force_field", "gaff2")` to `params.get("forcefield", "gaff2")` to match the node definition key
3. **Command ordering:** Fixed to match LAMMPS convention: bond_style → angle_style → dihedral_style → improper_style → pair_style → pair_modify → special_bonds → kspace_style → read_data
4. **Added `special_bonds` and `pair_modify`:** CHARMM mode now emits `special_bonds lj 0.0 0.0 0.0` and custom mode supports `params.get("special_bonds")` and `params.get("pair_modify")`
5. **Fixed `neigh_modify` argument order:** Changed from `every 1 delay 0 check yes` to `delay 0 every 1 check yes`
6. **Made `thermo_style` ensemble-aware:**
   - NVT/NVE: `step temp pe ke etotal press vol density`
   - NPT: `step temp pe ke etotal press vol density lx ly lz` (includes box dimensions)
7. **Fixed NPT fix command:** Now uses `params.get("pressure", 1.0)` instead of hardcoded `iso 1.0 1.0`
8. **Safety net:** Added check that returns an informative comment if content is empty or whitespace-only, so the preview endpoint can never return a blank response

**Benefits:**
- LAMMPS input preview now works correctly in both web and desktop modes
- Monaco editor always displays up-to-date content when the API call completes
- Preview output matches exactly what the execution engine generates
- Proper error handling when no structure is connected to the node

## Read These Next

- `server/CLAUDE.md`
  - backend incident log + MCP / workflow notes
- `src/lib/workflow/CLAUDE.md`
  - workflow UI and workflow-specific gotchas
- `src/lib/api/CLAUDE.md`
  - frontend data-access routing across Tauri / desktop / browser
- `src-tauri/CLAUDE.md`
  - Rust desktop backend
- `WORKFLOW_BUGS.md`
  - current CatBot / workflow authoring pitfalls
