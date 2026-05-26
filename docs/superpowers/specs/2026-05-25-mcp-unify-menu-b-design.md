# MCP Registry Unification — Single Surface on the Consolidated ("Menu B") Tools

**Date:** 2026-05-25
**Status:** Design — awaiting implementation plan
**Depends on:** PR #138 (lateral heterostructure) touches `server_claude_code.py`; this work stacks on or merges after it.

## Problem

CatGO exposes its FastAPI backend over MCP through **two independently hand-maintained tool registries**:

| | "Menu A" (granular) | "Menu B" (consolidated) |
|---|---|---|
| Source | `server/catgo/mcp_tools/tools/*.py` (declarative dicts) + `server.py` dispatch | `server/catgo/mcp_tools/server_claude_code.py` (`TOOLS` + inline `_handle_*`) |
| Shape | 70 tools, one per backend op (`catgo_add_atom`, `catgo_supercell`, …) | 15 action-based mega-tools (`catgo_structure(action=…)`, …) |
| Transport | stdio (`server.py`) | HTTP `/api/mcp` + SSE (`mcp_http.py`, `mcp_sse.py`), and a stdio launcher |
| Purpose | full surface for clients that tolerate many tools | low token footprint for Claude Code's system prompt |

Both ultimately call the same backend. The pain is **double maintenance → capability drift**: a new feature must be added in both places, and missing one leaves the two MCPs behaving differently. This already happened (e.g. the lateral heterostructure feature had to be written into both registries). Current drift:

- **Only in Menu A:** defect/strain/passivate/water-layer/reticular(MOF) building; 16 MD-trajectory analyses; bands/COHP/DOS-variant post-processing; LAMMPS/QE/VASP input generation; kMC.
- **Only in Menu B:** `catgo_workflow_engine` (HPC), `catgo_quickbuild`, `catgo_diagnose`, `catgo_skills`, `catgo_file`.

## Decision

**Unify on Menu B (consolidated).** Menu B's design is good and stays; Menu A is retired. Capabilities that exist only in Menu A are folded into Menu B as new actions / new mega-tools ("补齐"). All transports then serve the single Menu B surface.

Scope is deliberately bounded: **static capability gap-fill + transport unification only.** Dynamic/plugin features that live in `server.py`'s dispatch — `catgo_create_tool`, `catgo_ext_*`, plugin hot-loading, atomate2/quacc template imports — are **preserved (not deleted) and left for a follow-up**; `tools/` is not physically deleted in this pass, only removed from the live serving path.

## Target architecture

```
                 ┌─────────────────────────────────────┐
                 │  server_claude_code.py  (SINGLE       │
                 │  SOURCE: Menu B TOOLS + _handle_*)     │
                 └─────────────────────────────────────┘
                    ▲              ▲                 ▲
        stdio       │   HTTP /api/mcp   SSE          │
   server.py ───────┘   mcp_http.py ───┘   mcp_sse.py┘
   (repointed)          (already B)         (already B)
```

- `server_claude_code.py` is the one definition of tools and dispatch.
- `server.py` (stdio) is repointed: `list_tools` returns Menu B `TOOLS` + plugin defs; `call_tool` routes Menu B tools to Menu B handlers while **keeping** the existing plugin / tool-lifecycle / import branches.
- `mcp_http.py` / `mcp_sse.py` are unchanged (already import Menu B).
- `tools/*.py` declarative registry is no longer served (kept on disk, marked deprecated).

## Capability migration (Menu A → Menu B)

New tool count: **15 → 18** (only `catgo_md`, `catgo_input`, `catgo_simulate` added; everything else folds into existing mega-tools as actions).

### 1. `catgo_structure` — +5 building actions
| action | backend endpoint |
|---|---|
| `defect` | `POST /build/defect` |
| `strain` | `POST /build/strain` |
| `passivate` | `POST /pseudo-hydrogen/passivate` |
| `water_layer` | `POST /water-layer/add` |
| `reticular` | `POST /reticular/build` |

### 2. `catgo_analyze` — +9 electronic-structure / info actions
| action | backend endpoint |
|---|---|
| `bands` | `POST /bands/data` |
| `bands_from_dir` | `POST /bands/from-directory` |
| `bands_projections` | `POST /bands/projections` |
| `cohp` | `POST /cohp/data` |
| `dos_total` | `POST /dos/total` |
| `dos_dband` | `POST /dos/dband` |
| `dos_from_dir` | `POST /dos/from-directory` |
| `energy` | `POST /optimize/energy` |
| `calculators` | `GET /optimize/calculators` |

(Existing `dos` → `/dos/compute` stays. The bands trio may be grouped under one `bands` action with a sub-mode if it keeps the enum tidy — decided at plan time.)

### 3. `catgo_md` — NEW, 16 trajectory-analysis actions
| action | endpoint | | action | endpoint |
|---|---|---|---|---|
| `rdf` | `/md/distances/rdf` | | `hbonds` | `/md/hbonds/detect` |
| `msd` | `/md/dynamics/msd` | | `hbond_lifetime` | `/md/hbonds/lifetime` |
| `rmsd` | `/md/rmsd/rmsd` | | `water_orientation` | `/md/orientation/water` |
| `rmsf` | `/md/rmsd/rmsf` | | `dihedrals` | `/md/angles/dihedrals` |
| `clustering` | `/md/clustering/rmsd-cluster` | | `planar_density` | `/md/density/planar` |
| `dimreduce` | `/md/clustering/dimreduce` | | `cavitation` | `/md/cavitation/profile` |

(Note: backend `/md/distances/rdf` is *trajectory* RDF, distinct from `catgo_analyze:rdf` → `/analysis/rdf` which is single-structure RDF. Both retained.)

### 4. `catgo_input` — NEW, 9 input-generation actions
| action | endpoint |
|---|---|
| `lammps` | `POST /lammps/input` |
| `lammps_pair_styles` | `GET /lammps/pair_styles` |
| `lammps_sequential` | `POST /lammps/sequential` |
| `lammps_validate` | `POST /lammps/validate` |
| `qe` | `POST /qe/input` |
| `qe_templates` | `GET /qe/templates` |
| `vasp` | `POST /vasp/generate` |
| `vasp_calc_types` | `GET /vasp/calculation-types` |
| `vasp_presets` | `POST __direct__/vasp_presets` |

### 5. `catgo_simulate` — NEW, 2 kMC actions
| action | endpoint |
|---|---|
| `kmc_scan` | `POST /kmc/scan-potential` |
| `kmc_simulate` | `POST /kmc/simulate` |

### Already covered by Menu B (no migration)
Structure edits (`/structure-ops/*`, set-lattice, generate-slab, merge), fetch (crystal/search/molecule), heterostructure (+lateral), moire, nanotube, catalysis, symmetry, coordination, adsorption sites, dft_input, optimize, view (screenshot/selection/structure-info via `get_state`), workflow, workflow_engine.

## Handler design

Each migrated action follows the existing Menu B handler conventions:

- **Routing:** extend the per-tool `ROUTES`/dispatch table (as in `_handle_analyze`) with `action → (METHOD, endpoint)`; new tools (`catgo_md`, `catgo_input`, `catgo_simulate`) get their own `_handle_*` with the same table pattern.
- **Structure auto-injection:** POST endpoints needing a structure pull the current viewer structure when the caller omits it (existing `_get_current_structure` pattern). MD/bands/cohp/dos-from-dir actions instead take a **directory path or trajectory** argument — they do *not* auto-inject the viewer structure.
- **Result handling:** responses carrying a `structure` are pushed to the viewer (`_push_structure`); analysis/data responses are returned as JSON text. Mirrors current behavior.
- **Errors:** non-200 → concise `"<action> failed (<code>): <body[:300]>"`; unknown action → list valid actions. Same as today.
- **`__direct__` ops** (`vasp_presets`): call the Python module directly, as `server.py`'s `_handle_direct_tool` does — port that one helper into the consolidated handler.

## Transport unification

- `server.py`: replace `from catgo.mcp_tools.tools import TOOLS` with Menu B `TOOLS`; replace the declarative `call_tool` body with delegation to the Menu B `call_tool` dispatch, **retaining** the plugin/`catgo_create_tool`/`catgo_ext_*`/import branches that precede the declarative path.
- `mcp_http.py`, `mcp_sse.py`: unchanged.

## Testing

- **Schema tests** (extend `test_lateral_hetero_mcp.py` style / a new `test_consolidated_registry.py`): every new action appears in the right tool's enum; `catgo_md`/`catgo_input`/`catgo_simulate` exist with expected actions; tool count == 18.
- **Routing tests** (fake httpx client, as in the lateral tests): each new action POSTs/GETs the correct endpoint with the expected body keys; structure auto-injection fires only where intended; viewer push fires for structure-returning actions.
- **Parity test:** assert that every backend endpoint previously reachable via Menu A is reachable via some Menu B `(tool, action)` — a static map check so future drift is caught.
- **Live smoke** (against `:8000`, opt-in): one representative call per new tool (`catgo_structure:defect`, `catgo_md:rdf` on a sample trajectory, `catgo_input:vasp`, `catgo_simulate:kmc_simulate`) returns 200.
- **Regression:** existing consolidated handler tests still pass. (Note the pre-existing 10 stale failures in `test_claude_code_mcp.py` — tool count 11 vs 15; this work makes it 18, so that test must be updated to the new count and the ≤300-char description assertion relaxed or scoped, as part of this PR.)

## Out of scope (follow-up)

- Migrating dynamic plugin / tool-lifecycle features (`catgo_create_tool`, `catgo_ext_*`, plugin hot-load, atomate2/quacc imports) into the consolidated registry.
- Physically deleting `tools/*.py` and the declarative dispatch in `server.py`.
- Auto-generating tool schemas from a single capability table (a deeper refactor; this pass keeps hand-written Menu B tools but makes them the *only* surface).

## Risks

- **Mega-tool description bloat:** `catgo_md` (16) and `catgo_analyze` (10→19) get long action enums + descriptions. Tool *count* stays low (the token lever that mattered), so this is acceptable; keep per-action descriptions terse.
- **Breaking change for granular-stdio clients:** clients with `.claude/mcp.json` pointing at the granular `mcp_server.py` will see consolidated tool names after this lands. Functionally equivalent (same ops via actions); documented in the PR.
- **Merge conflict with PR #138:** both edit `server_claude_code.py`; sequence this after #138 merges or rebase onto it.
