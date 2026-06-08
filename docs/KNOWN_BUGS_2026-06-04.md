# CatGo — Bug Log (discovered 2026-06-04 session)

Found while building a Pt(111) ORR workflow + chasing why slab freezing wasn't
visible/consistent. Grouped by area. **FIXED** = patched this session (branch
`fix/workflow-db-active-path-persistence`, uncommitted). **OPEN** = still to fix.

Legend: 🟢 fixed · 🟡 partial · 🔴 open

---

## A. Workflow persistence / engine

### A1 🟢 Dual workflow DB — created workflows invisible in list/GUI
`create_workflow`/`get_workflow` wrote/read `server/catgo/data/catgo_results.db` while
`list_workflows` (and the FE sidebar) read a *different* file — the active DB path is a
mutable global (`ase_db._active_db_path`) switched at runtime by `db/open` and **not persisted**.
A fresh backend defaulted to the packaged DB; the FE later re-opened the project DB → API-created
workflows orphaned in the wrong file.
**Fix:** `ase_db.set_active_db_path` now resolves to absolute + persists to
`server/catgo/data/.active_db_path`; `restore_active_db_path()` called in `main.py` lifespan.
Test: `server/tests/test_active_db_persistence.py` (3 pass).

### A2 🔴 V1/V2 dual representation + status divergence
One executor (V2 state-machine engine) but a leftover "V1" representation: `graph_json` +
`workflow_steps` (in `catgo_results.db`) vs V2 `tasks/...` (in `~/.catgo/catgo.db`), bridged by
`convert_graph_json`, `v1_monitor`, `list_steps_v1`, `_V2_TO_V1_STATUS`. Symptom seen: `/run-status`
(V1) reported `draft`/no-fail while the GUI (V2) showed a node FAILED. Two DBs, two API surfaces
(`/api/workflow/*` vs `/api/engine/*`), partly-vestigial `workflow_steps`, two status vocabularies.
**To fix:** converge to V2-only; FE consumes V2 entities + WS format; drop `workflow_steps`; single DB.
See `docs/superpowers/specs/2026-06-04-workflow-engine-as-built.md` (seam list).

---

## B. Workflow editor (frontend)

### B1 🟢 Editor edge loader too strict → edges don't render
`WorkflowEditor.load_workflow`/`reload_from_server` spread stored edges as-is, expecting the native
`{from,to,fromH,toH}`. Graphs in other dialects (`source/target` from templates/REST,
`fromHandle/toHandle` from `to_workflow_json`'s own save, react-flow `sourceHandle`) had no
anchors → **no connecting lines**. (Tauri `db-wasm.ts` already normalized; the browser loader did not.)
**Fix:** normalize all dialects → `from/to/fromH/toH` in both load paths.

### B2 🟢 `to_workflow_json` ↔ loader handle-key mismatch (round-trip)
Editor *saves* `fromHandle/toHandle` but *reads* `fromH/toH` → an editor-saved graph reloaded in the
browser lost its handles. Covered by the B1 normalization.

### B3 🟢 NodeConfigPanel hides the freeze field by default
`frozen_layers` lives in the `Slab` param group, which was **not** in `ALWAYS_OPEN_GROUPS` → collapsed
→ users couldn't see/edit the freeze setting on geo_opt/slab.
**Fix:** added `Slab` to `ALWAYS_OPEN_GROUPS`.

### B4 🟢 "Simulate" fabricates random failures
`workflow-execution.svelte.ts:584` did `Math.random() > 0.1 ? 'completed' : 'failed'` — a pure
front-end animation that randomly failed ~10% of nodes, **misleading users into thinking a valid
workflow was broken**. No backend, no validation.
**Fix:** deterministic dependency-order preview (all complete). **To improve:** make it a real local
dry-run (validate + input-gen per node) instead of a cosmetic animation.

### B5 🟡 Freeze not shown past the node that owns the freeze param
`apply_freeze_to_structure` (display overlay) was called **only for `freq`** nodes and only keyed off
`freeze_mode`. geo_opt/slab/adsorbate previews showed no frozen atoms.
**Fix (partial):** overlay now applied to `freq`/`geo_opt`/`slab_gen` + reads `frozen_layers` spellings +
`bottom` mode. **Still OPEN:** the overlay is display-only and doesn't flow; the **adsorbate node
preview** still shows no freeze because the FE structure it receives carries no `selective_dynamics`
(see C4/D2).

---

## C. Slab generation / freeze (backend)

### C1 🟢 `geo_opt`/`vasp_relax` ignored `frozen_layers` (slab never frozen)
`engines/vasp.py` applied bottom-layer freezing only for `node_type=="slab_relax"` and the `freq`
branch; the unified `geo_opt`→`vasp_relax` path dropped `frozen_layers` → **slabs ran unconstrained**.
**Fix:** broadened to `slab_relax`/`vasp_relax`/`geo_opt`; writes `fixed_z_below` + `selective_dynamics`.
Verified: p(3×3)5L → 18/45 frozen `F F F`.

### C2 🟢 Freeze param-spelling chaos
FE uses `frozen_layers`; most skills `freeze_mode="layers"`+`freeze_layers`; workflow_builder skill
`freeze_mode="bottom"`+`freeze_n_layers`. The engine's `freq` branch only matched `"layers"` (not
`"bottom"`) and geo_opt read only some names → agent/skill-built workflows silently unfrozen.
**Fix:** `_freeze_n_bottom_layers()` helper accepts all spellings; `freq` accepts `bottom`+`layers`.
All 6 producer conventions verified to freeze.

### C3 🟢 `run_slab_gen` ferrox path early-return dropped supercell/layers/freeze
The ferrox branch `return {"structure": slab_json}` ran **before** the supercell/freeze post-processing
(only the pymatgen fallback got it). It also passed `thickness` (ignoring `layers`).
**Fix:** unified both paths — honor `layers` (→thickness), apply supercell, write `selective_dynamics`.

### C4 🟢 `run_adsorbate_place` stripped `selective_dynamics`
Built output sites with `"properties": {}` → a frozen slab became **unfrozen the moment an adsorbate
was placed**. (the "传到 Adsorbate 就掉了" symptom)
**Fix:** slab atoms keep their flags; adsorbate atoms set free `[T,T,T]`. **Note:** pymatgen-fallback
branch + the **frontend WASM adsorbate path** still need the same preservation (see D2).

---

## D. ferrox build / worktree (environment)

### D1 🟢 ferrox Python missing `generate_slab_layers` binding
Rust `slab::generate_slab_layers` exists and is bound for **WASM** (frontend) but **not** for pyo3
(Python/backend) — backend only had thickness-based `generate_slab`. So frontend (layer-exact) and
backend (thickness) produced different cells.
**Fix:** added the pyo3 binding in `extensions/rust/src/python/surfaces.rs` + `maturin develop`.

### D2 🔴 Frontend/backend slab still inconsistent — 3 build sources
Even after D1, FE showed 20 atoms / backend 30. Causes:
- **D2a 🟢** ferrox Python was editable-installed from the **wrong worktree** (`catgo/.worktrees/split-files`,
  v0.0.4, older slab.rs 1071 lines) instead of `catgo-LRG` (1233 lines). → Rebuilt from catgo-LRG;
  removed the stale split-files worktree.
- **D2b 🔴** the FE `ferrox_bg.wasm` is a **stale prebuilt pkg** (older algorithm) — not rebuilt from
  current catgo-LRG src. Needs `pnpm build:wasm` so WASM = catgo-LRG = backend.
- **D2c 🔴** frontend WASM `adsorbate` placement strips `selective_dynamics` (same as C4 but the JS/WASM
  path) → adsorbate-node preview shows no freeze.
- **D2d 🔴** SlabGenPreview emits the slab structure **without** `selective_dynamics` (WASM path), so
  freeze doesn't flow to downstream node previews even though the backend persists it.

### D3 🔴 ferrox slab algorithm produces non-clean cells for cubic FCC (111)
`generate_slab_layers` on conventional/primitive cubic Pt(111) yields awkward super-surface cells
(e.g. ~6–22 atoms/layer, non-c-perpendicular) instead of a clean primitive p(n×n). Can't cleanly get
a 45-atom 1/9 ML p(3×3) through it. ASE `surface()`/`fcc111` gives exact, c-perpendicular layers.
**To fix:** reduce to the primitive surface cell before tiling, or align with ASE-style construction.

---

## E. Not a CatGo bug (paper, tracked separately)
- Pt(111) ORR demo reports η ≈ 0.756 V vs canonical ≈0.45 V (under-converged demo settings: ENCUT 450,
  atop O*, sparse k). Being re-run converged (RPBE, O* fcc, dipole, etc.). See
  `Downloads/20260416_CatGo/revision/`.

---

## Update — later 2026-06-04 (found while running the ORR jobs on Expanse)

### C5 🟢 `run_adsorbate_place` couldn't read a CONTCAR (only JSON)
`run_adsorbate_place` did `json.loads(struct_str)` (builtins_impl.py:336) but an upstream
`geo_opt` passes its **relaxed CONTCAR (POSCAR text)**, not pymatgen-JSON → `JSONDecodeError`,
so all three adsorbate nodes failed the moment `slab_opt` produced a real CONTCAR.
**Fix:** accept POSCAR/CONTCAR text too (parse via pymatgen → JSON; preserves the slab's
`selective_dynamics`). Verified: OOH/O/OH place on the relaxed slab, 18 frozen / adsorbate free.

### A3 🔴 Concurrent workflows delete each other's V2 tasks → **issue #227**
Running two workflows at once: re-running/converting one wiped the OTHER's tasks (a workflow with
a COMPLETED `slab_opt` dropped to 0 tasks, losing the collected CONTCAR result). Cannot run two
workflows concurrently safely. (Workaround: run serially.)

### A4 🔴 run-config nested `cluster_configs[sid].default_job_params` not propagated → **issue #228**
`partition`/`ntasks`/`walltime`/`memory` (and `default_session_id`) from the run config's nested
cluster `default_job_params` never reach `hpc.job_defaults`, so jobs default to `partition="workq"`
→ `sbatch: Partition workq not found`. Had to hand-patch `config_json.hpc.job_defaults` in
`~/.catgo/catgo.db` on every run. Fix in `_run_config_to_engine_config`.

> Operational note: SCF divergence on the Gamma-only Pt metal slab was traced to the **dipole
> correction (LDIPOL)** — removing it + ALGO=Fast/NPAR=2 converged cleanly (E0 ≈ −398 eV). Not a
> CatGo code bug; a setting. Also hit a transient Expanse-side "Invalid account/partition" block
> for ALL valid accounts after many rapid sbatch retries (cluster rate-limit/accounting).

## Fix-priority suggestion (open items)
1. **D2b** `pnpm build:wasm` → kill the FE/backend slab mismatch (cheap, high impact).
2. **D2c/D2d/C4-fallback** make `selective_dynamics` flow through the FE pipeline (slab emit +
   adsorbate preserve) → freeze visible on every node.
3. **D3** clean primitive-surface slab construction (correct cells).
4. **A2** V1→V2 convergence (retire the compat skin).
5. **B4** real Simulate dry-run.
