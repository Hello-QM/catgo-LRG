# MACE Ni Surface Benchmark — Implementation Plan

**Date:** 2026-04-18
**Base commit:** `384e0a85` on `split-files` (post tab-isolation Phase 2, pushed to origin)
**Branch:** `feature/mace-ni-benchmark` branched off `split-files` (not `main`)
**Goal:** Reproduce Kreitz 2021 Ni surface DFT-D3 benchmark using MACE-MP-0 inside CatGo, end-to-end, with full reproducibility metadata.

---

## ⚠️ Branching note

`origin/main` points to a different project ("MatterViz" — CatGo's upstream base). The CatGo-specific workflow engine, MLP infrastructure, skills system, and project dashboard **only exist on CatGo feature branches** (including `split-files`, `dev`, `CatGo-PRO`, `mlp-vibrations`, etc.), not on `main`.

This plan and its implementation branch are therefore based on `split-files`, which contains the most recent integrated CatGo state (tab-isolation Phase 2 just shipped).

When this work is complete:
- Merge target is TBD — discuss with colleague whether the integration branch is `split-files`, `dev`, or a CatGo-specific `main`.
- Do NOT merge to upstream `origin/main` (MatterViz).

---

## 1. Success criterion

A user:
1. Opens ProjectDashboard for a new project.
2. Clicks "New Workflow → From preset → MACE Ni Benchmark".
3. Picks execution mode (HPC Cluster default, Local fallback) in the Run Config dialog.
4. Hits Run.
5. After ~10 min on GPU HPC (or ~1 h on local CPU), opens the "Benchmark" tab in the dashboard.
6. Sees a comparison table with all 6 target quantities + Kreitz 2021 reference column + Δ column + reproducibility metadata.
7. Clicks "Export CSV" and sends to their colleague.

---

## 2. The six target quantities

| # | Quantity | Formula | Units |
|---|---|---|---|
| 1 | γ(hkl) for (111), (100), (110), (211) | `(E_slab − n_slab/n_bulk × E_bulk) / (2A)` via linear extrapolation | J/m² |
| 2 | Wulff facet area fractions from the 4 γ values | `pymatgen.analysis.wulff.WulffShape` | — |
| 3 | Differential H adsorption energy on Ni(111) FCC hollow, ZPE-corrected | `E(slab+H) − E(slab) − 0.5·E(H₂) + ΔZPE` | eV |
| 4 | Coverage slope ∂E_ads/∂θ on 4×4 Ni(111), 5 coverages 1H..5H | Linear fit of E_ads vs θ | eV/ML |
| 5 | CO* → C* + O* NEB forward barrier on Ni(111) | NEB with climbing image | eV |
| 6 | TS imaginary-mode frequency | Finite-difference Hessian, imaginary mode | cm⁻¹ |

Plus reproducibility metadata: MACE model + version, torch version, device, wall time, host.

---

## 3. Verified existing capabilities (do NOT rebuild)

All verified 2026-04-18 by reading the files:

| Capability | File:line |
|---|---|
| MLP engine (single_point / relax / vibrations / neb / md) | `server/workflow/engines/mlp.py:119-860` |
| MLP HPC path | `server/workflow/engines/mlp.py:375` (`generate_mlp_input_files`) |
| HPC Jinja template for MLP | `server/workflow/templates/mlp/run_mlp.py.j2` |
| MLP local subprocess path | `server/workflow/engines/mlp.py:381` (`execute_mlp_local`) |
| Frontend ML Potential option | `node-defs/calculation.ts:30-44`, `common.ts:60-62,339-345` |
| Surface-energy analysis | `analysis.py:985-1153` (`_analyze_surface_energy`), dispatched `analysis.py:225` |
| Wulff construction analysis | `analysis.py:1168-1287` (`_analyze_wulff`), dispatched `analysis.py:230` |
| Wulff 3D + 2D visualization | `src/lib/workflow/WulffShape3D.svelte`, `WulffPlot.svelte`, wired at `NodeStatusPanel.svelte:22-23, 1850, 1858` |
| Coverage fan-out (`batch_coverage_gen`) | `server/workflow/engines/local.py:778-924` (uses pymatgen `AdsorbateSiteFinder`) |
| Coverage slope analysis | `node-defs/analysis/coverage-analysis.ts`, backend `_analyze_coverage` at `analysis.py:240` |
| Batch slab generation | `node-defs/utility/batch-slab-gen.ts` |
| Miller preset includes (211) | `miller-slab.ts:1759` |
| Adsorbate placement (hollow/bridge/ontop) | `node-defs/utility/batch-adsorbate-place.ts:19-25` |
| Adsorption energy analysis (ZPE-aware) | `_analyze_adsorption_energy` at `analysis.py:1358` |
| MLP tests | `server/tests/test_mlp_single_point.py`, `test_mlp_vibrations.py`, `test_mlp_neb.py` |
| `mace-torch>=0.3.0` in requirements | `server/requirements.txt:39` |
| Skills directory structure | `server/catgo/workflow/skills/` (has `analysis/`, `structure/`, `vasp/`, `orca/`, etc.) |

---

## 4. Design decisions (approved)

1. **ASE-MACE only in v1** — existing engine is ASE-based. LAMMPS-MACE integration deferred until explicit need.
2. **Benchmark preset defaults `execution_mode=hpc`** — user's colleague has HPC GPU access. Falls back to local CPU for users without HPC.
3. **Default MACE model: `mace-mp-0 medium`** — ~200 MB checkpoint, auto-downloaded to `~/.cache/mace/`. Users can override via new `model_path` param for fine-tuned `.model` files.
4. **Frequency default: freeze Ni slab, vibrate adsorbate only** — uses existing `freeze_mode="element"` + `freeze_elements="Ni"` + `freeze_invert=true`. Drops FD cost ~20×.
5. **NEB endpoints user-provided** — preset includes two `adsorbate_place` branches (CO* and C+O*), user configures both manually. No auto-product generation in v1.
6. **Coverage generator: static DAG expansion** — existing `batch_coverage_gen` already does this. Deterministic site ordering via pymatgen.
7. **Reproducibility metadata schema**: `{mace_torch_version, torch_version, mace_model, model_sha256, device, gpu_name, wall_time_s, host, timestamp}` attached to every MLP result's `result_json`.

---

## 5. Gap summary

Five items, ~400 LOC total. Roughly 3–4 engineer-days.

| # | Gap | Effort | Scope |
|---|---|---|---|
| G1 | Reproducibility metadata | Small | `mlp.py` local path + `run_mlp.py.j2` template, ~60 LOC combined |
| G2 | `mace_ni_benchmark` preset | Medium | New `server/workflow/presets/mace_ni_benchmark.py`, ~150 LOC, registered via `templates.py` |
| G3 | Benchmark results table UI | Medium | New `src/lib/workflow/BenchmarkTable.svelte`, ~150 LOC, mounted as a new tab in `ProjectDashboard.svelte` |
| G4 | Skill documentation | Docs | New `server/catgo/workflow/skills/analysis/mace_ni_benchmark/SKILL.md` + README |
| G5 | Regression test | Small | `server/tests/test_mace_ni_benchmark.py` with `@pytest.mark.slow`, ~80 LOC |

Optional:
- `is_valid_ts` convenience flag in `mlp_vibrations` result (~10 LOC)

---

## 6. Checkpoint-by-checkpoint build sequence

Each checkpoint is independently shippable and verifiable.

### Checkpoint 1 — Reproducibility metadata plumbing (0.5 day)

**Modify:**
- `server/workflow/engines/mlp.py`:
  - In `_build_calculator_block()`: record `mace_torch.__version__`, `torch.__version__`, resolved `mace_model` name, compute `model_sha256` via `hashlib.sha256` on checkpoint file, write to `metadata.json` at end of generated script.
  - In `execute_mlp_local()`: read `metadata.json` from work dir, merge into `result_data["metadata"]`.
  - Add `device` auto-detection (`"cuda:0" if torch.cuda.is_available() else "cpu"`) + expose a `device` param override (`auto`/`cpu`/`cuda`).
- `server/workflow/templates/mlp/run_mlp.py.j2`: mirror the same metadata block so HPC path records it.
- `src/lib/workflow/node-defs/common.ts`: add `device` and `model_path` params to `mlp_only()` block so every MLP-capable node exposes them.

**Verify:** Create a 1-node workflow `Structure Input → Single Point (MLP, MACE)` on water. POST `/api/workflow/{id}/run`. Expected in result.outputs_json:
```json
{
  "energy": ...,
  "metadata": {
    "mace_torch_version": "0.3.x",
    "torch_version": "2.x.x",
    "mace_model": "mace-mp-0-medium",
    "model_sha256": "a1b2c3...",
    "device": "cpu" | "cuda:0",
    "wall_time_s": 12.3,
    "host": "yourmachine.local",
    "timestamp": "2026-04-18T09:40:00Z"
  }
}
```

**Shippable independently:** yes. Useful for any MLP workflow, not just the benchmark.

---

### Checkpoint 2 — `is_valid_ts` convenience flag (optional, 0.5 day)

**Modify:**
- `server/workflow/engines/mlp.py` `mlp_vibrations` branch: add to result dict:
  - `imag_modes_cm: list[float]` (frequencies < 0, already sort negative = imaginary)
  - `dominant_imag_freq_cm: float | null`
  - `is_valid_ts: bool` — true iff exactly one imaginary mode AND that mode's |freq| > 20 cm⁻¹ (filters trivial rotation/translation modes)
- `src/lib/workflow/NodeStatusPanel.svelte`: if freq result has `is_valid_ts === false`, show amber warning badge with count/values.

**Verify:** Run freq on a known TS → badge shows "Valid TS ✓ (1 imaginary at -412 cm⁻¹)". Run on a minimum → badge shows "Not a TS: 0 imaginary".

**Shippable independently:** yes.

**Can be skipped** if time-constrained; user can inspect frequencies manually.

---

### Checkpoint 3 — `mace_ni_benchmark` preset (1 day)

**Create:**
- `server/workflow/presets/mace_ni_benchmark.py` — preset generator. Pattern matches existing `vasp.py`. Emits ~20-node DAG:

**DAG structure:**
```
1. Bulk branch:
   structure_input (Ni fcc, a=3.524 Å) → geo_opt (MLP, MACE, relax_cell=true)
     → exposes E_bulk for surface-energy extrapolation.

2. Surface energy branch (×4 facets):
   structure_input (Ni bulk) → batch_slab_gen (miller={(111),(100),(110),(211)}, layers={4,6}, vacuum=15)
     → map → geo_opt (MLP, MACE, fix_bottom_layers=2)
     → surface_energy (per-facet linear extrapolation, output γ in J/m²)

3. Wulff:
   surface_energy → wulff_construction → Wulff 3D shape + facet fractions (already visualizes in NodeStatusPanel)

4. H adsorption branch:
   structure_input (Ni bulk) → slab_gen ((111), 4 layers, 3×3) → geo_opt (clean slab)
     → adsorbate_place (H, site_strategy=hollow, 1 H) → geo_opt (MLP)
     → freq (MLP, vibrate adsorbate only, nfree=2)

   Parallel: reference_mol (H2) → geo_opt (MLP) → freq (MLP)

   Both merge → adsorption_energy (ZPE-corrected, coeff=0.5 for H from H2)

5. Coverage branch:
   structure_input (Ni bulk) → slab_gen ((111), 4 layers, 4×4) → geo_opt
     → batch_coverage_gen (H, coverages=[1,2,3,4,5], site=hollow)
     → map → geo_opt (MLP)
     → coverage_analysis (clean_slab ref, H2 ref) → slope ∂E_ads/∂θ

6. NEB branch:
   Reactant: slab_gen ((111), 4 layers, 3×3) → adsorbate_place (CO, site_strategy=ontop) → geo_opt (MLP)
   Product:  slab_gen ((111), 4 layers, 3×3) → adsorbate_place (C+O, site_strategy=hollow×2) → geo_opt (MLP)
   Both → ts_search (MLP NEB, nimages=7, climb=true, spring_k=0.1)
   TS structure → freq (MLP, vibrate adsorbate+contact atoms, nfree=4) → ν_imag
```

- `server/workflow/presets/templates.py` (or wherever presets register): add `mace_ni_benchmark` with metadata tag `{"preset": "mace_ni_benchmark", "schema_version": 1}`.

**Modify:**
- None required if preset registration auto-discovers new files. Verify by grepping `create_from_template` in `server/catgo/routers/workflow.py`.

**Verify:** In Workflow Editor "New from preset" menu, select "MACE Ni Benchmark". 20-node DAG appears on canvas with all connections in place. Don't run yet — just verify the structure is correct.

**Depends on:** Checkpoint 1 (for metadata on every MLP result).

---

### Checkpoint 4 — End-to-end smoke run (0.5 day)

No new code. Use Checkpoint 3's preset on a reduced configuration:
- Only γ(111) and γ(100) (not all four facets)
- Only 2 coverages (not 5)
- NEB with nimages=5 (not 7)

This validates the DAG executes without errors. Runs in ~5 min on GPU HPC.

**Verify:** All terminal nodes reach `completed`. Results are non-empty. Fix any DAG wiring errors found here.

**Depends on:** Checkpoint 3.

---

### Checkpoint 5 — Benchmark results table UI (1 day)

**Create:**
- `src/lib/workflow/BenchmarkTable.svelte` — ~150 LOC component. Queries the project's enriched results via existing `get_enriched_results()` endpoint. Extracts the 6 target quantities by `analysis_type`:
  - `surface_energy` → 4 γ values grouped by facet label
  - `wulff_construction` → area fractions
  - `adsorption_energy` → E_ads (ZPE-corrected)
  - `coverage_result` → slope
  - NEB result → `activation_barrier_kcal_mol` (convert to eV)
  - freq result on TS → `dominant_imag_freq_cm`
- Renders two-column comparison: **CatGo-MACE** | **Kreitz 2021 DFT-D3** (reference values hardcoded for v1; later can be a config file).
- Reproducibility metadata row showing model SHA256, wall time, device, host.
- Export CSV button.

**Modify:**
- `src/lib/workflow/ProjectDashboard.svelte`: when `project.metadata.preset == "mace_ni_benchmark"` or any workflow in project has that tag, add third tab "Benchmark" mounting `<BenchmarkTable project_id={id} />`.
- Verify `server/catgo/routers/project.py::get_enriched_results` returns `analysis_type` per step (check existing schema).

**Verify:** Complete a benchmark run. Open project → click Benchmark tab → see all 6 numbers with Δ vs Kreitz values, metadata row populated. Export CSV, verify format.

**Depends on:** Checkpoint 4 (need real data to populate table).

---

### Checkpoint 6 — Skill documentation (0.5 day)

**Create:**
- `server/catgo/workflow/skills/analysis/mace_ni_benchmark/SKILL.md` — CatBot-readable skill description:
  - "When user says `reproduce Kreitz 2021 Ni benchmark` or `run MACE Ni benchmark`, invoke preset `mace_ni_benchmark`"
  - The 6 quantities and their computation
  - Known MACE-MP-0 vs DFT-D3 deviations (typical ~0.1 J/m² on γ, ~0.1 eV on E_ads, ~0.2 eV on barrier)
  - Manual NEB endpoint step
  - HPC vs local execution tradeoffs
- `server/catgo/workflow/skills/analysis/mace_ni_benchmark/README.md` — human-readable user doc.

**Modify:**
- `server/catgo/workflow/skills/SKILL.md` (or wherever the skill index lives): add row pointing to this new skill.

**Verify:** Ask CatBot "run the Kreitz Ni benchmark" — it should discover the skill and invoke `catgo_workflow_engine action=create preset=mace_ni_benchmark`.

**Shippable independently:** yes, documentation-only. Can be written in parallel with code checkpoints.

---

### Checkpoint 7 — Regression test (0.5 day)

**Create:**
- `server/tests/test_mace_ni_benchmark.py` — `@pytest.mark.slow` end-to-end test. Uses a minimal reduced preset:
  - 2×2×2 Ni(111) only (skip the full 4-facet survey)
  - Single coverage (skip the 1H..5H sweep)
  - Skip NEB (too expensive for CI)
  - `mace_mp(model="small")` to keep < 2 min on CPU
- Assertions:
  - γ(111) ∈ [2.0, 2.8] J/m² (MACE-MP-0 tolerance)
  - E_ads(H @ FCC hollow) ∈ [-0.6, -0.3] eV
  - Reproducibility metadata present with non-empty mace_torch_version
- Mark with `@pytest.mark.slow` so CI skips by default; run manually with `pytest -m slow`.

**Verify:** `pytest server/tests/test_mace_ni_benchmark.py -m slow -v` passes locally in under 5 min on CPU.

**Shippable independently:** yes, assuming Checkpoints 1+3 are in place.

---

## 7. Risks

1. **MACE-MP-0 vs DFT-D3 numerical discrepancy**
   - MACE-MP-0 is a foundation model; it will NOT exactly reproduce Kreitz's DFT-D3 numbers.
   - Expect: γ within ~0.1 J/m², E_ads within ~0.1 eV, barrier within ~0.2 eV.
   - **Mitigation:** Checkpoint 5's table shows MACE value AND Kreitz reference side-by-side with Δ. Checkpoint 6's skill doc explicitly describes expected deviation magnitudes.

2. **`mace-torch` install failures on user machines**
   - Already handled by existing error path in `mlp.py:524-540` (prints install instructions on `ModuleNotFoundError`).
   - CUDA version mismatch can cause `RuntimeError: CUDA error: no kernel image is available`.
   - **Mitigation:** Extend the existing error handler to detect CUDA arch mismatch and suggest the CPU-only wheel.

3. **Frequency FD cost on large slabs**
   - 4×4 Ni(111) + H slab ≈ 65 atoms × 2 (central diff) × 3 (xyz) = 390 single-points per freq. ~1 min on GPU, ~20-30 min on CPU. ×5 for coverage study = 25+ min CPU just for freq.
   - **Mitigation:** Default Checkpoint 3's preset to `freeze_mode="element"` + `freeze_elements="Ni"` + `freeze_invert=true`. Drops cost ~20×. ~50 s per freq on CPU for just-adsorbate vibrations.

4. **HPC queue time for small jobs**
   - A 16-atom Ni slab geo_opt takes 5 min of compute but 30 min of queueing on busy GPU nodes.
   - **Mitigation:** User picks per-run. Benchmark preset defaults to HPC but Run Config lets users flip to local on the fly.

5. **Coverage fan-out DAG size**
   - 5 coverages × multiple tool chains = many parallel jobs. Could saturate HPC quota.
   - **Mitigation:** The workflow engine already queues jobs per HPC partition; no CatGo-side change needed. Document in the skill.

6. **`mace-mp-0 medium` model distribution**
   - ~200 MB checkpoint auto-downloads from HuggingFace on first use. Slow first-run.
   - **Mitigation:** Skill doc notes "first run will download the model (~2 min)". Cached to `~/.cache/mace/` for subsequent runs.

---

## 8. Dependency map

```
C1 (metadata) ──┬──> C3 (preset) ──> C4 (smoke run) ──> C5 (table) ──> C7 (test)
                │
C2 (is_valid_ts, optional) ──┘

C6 (skill doc) — independent, write any time.
```

No new Python packages required. `mace-torch>=0.3.0` is already in `server/requirements.txt:39`.

For smoke testing:
- `mace-mp-0 small` model (~50 MB) is sufficient
- CPU-only execution works; GPU ~20× faster

---

## 9. Minimum viable deliverable

**End of Checkpoint 5.** User can open the preset, run it, see a populated Benchmark table, export CSV, send to colleague.

Checkpoints 6 + 7 harden the deliverable (skill docs + CI regression test). Total ≈ 3–4 engineer-days for Checkpoints 1+3+4+5. Add 1 more day for 6+7.

---

## 10. Branching strategy

`origin/main` is a different project (MatterViz upstream). All CatGo infrastructure lives on feature branches. **Branch off `split-files`** — the most recent integrated CatGo state (tab-isolation Phase 2 just shipped there).

```bash
git fetch origin
git checkout -b feature/mace-ni-benchmark split-files
```

Each checkpoint → one commit. Ship as a single PR against whichever branch the colleague uses as CatGo's integration branch (`split-files`, `dev`, or similar — TBD).

**Do NOT PR against `origin/main`** — that would target MatterViz upstream, not CatGo.

---

## 11. Checkpoint ship summary

| Checkpoint | Files created | Files modified | Test/verify | Est. time |
|---|---|---|---|---|
| C1 — metadata | — | `mlp.py`, `run_mlp.py.j2`, `common.ts` | Single-point on water; check `result.metadata` | 0.5 d |
| C2 — is_valid_ts (opt) | — | `mlp.py` vibrations branch, `NodeStatusPanel.svelte` | Freq on a minimum and a TS; check badge | 0.5 d |
| C3 — preset | `presets/mace_ni_benchmark.py` | `templates.py` (registration) | Load preset → 20-node DAG appears | 1.0 d |
| C4 — smoke run | — | — | Reduced config completes; all nodes green | 0.5 d |
| C5 — table UI | `BenchmarkTable.svelte` | `ProjectDashboard.svelte`, `project.py` (if needed) | Full run → table populated, CSV export | 1.0 d |
| C6 — skill | `skills/analysis/mace_ni_benchmark/{SKILL,README}.md` | skill index | CatBot invokes preset via skill | 0.5 d |
| C7 — test | `tests/test_mace_ni_benchmark.py` | — | `pytest -m slow` passes | 0.5 d |

**Total:** 4.0 d core (C1+C3+C4+C5+C7) + 1.0 d hardening (C2+C6) = ~5 engineer-days including integration time.

---

## 12. Critical files reference

**Existing (read-only for this plan):**
- `/Users/jenedithpascasio/CatGO/server/workflow/engines/mlp.py`
- `/Users/jenedithpascasio/CatGO/server/workflow/engines/analysis.py`
- `/Users/jenedithpascasio/CatGO/server/workflow/engines/local.py`
- `/Users/jenedithpascasio/CatGO/server/workflow/templates/mlp/run_mlp.py.j2`
- `/Users/jenedithpascasio/CatGO/src/lib/workflow/node-defs/common.ts`
- `/Users/jenedithpascasio/CatGO/src/lib/workflow/node-defs/calculation.ts`
- `/Users/jenedithpascasio/CatGO/src/lib/workflow/NodeStatusPanel.svelte`
- `/Users/jenedithpascasio/CatGO/src/lib/workflow/ProjectDashboard.svelte`
- `/Users/jenedithpascasio/CatGO/src/lib/structure/miller-slab.ts`
- `/Users/jenedithpascasio/CatGO/server/workflow/presets/vasp.py` (pattern for C3)

**To create:**
- `/Users/jenedithpascasio/CatGO/server/workflow/presets/mace_ni_benchmark.py`
- `/Users/jenedithpascasio/CatGO/src/lib/workflow/BenchmarkTable.svelte`
- `/Users/jenedithpascasio/CatGO/server/catgo/workflow/skills/analysis/mace_ni_benchmark/SKILL.md`
- `/Users/jenedithpascasio/CatGO/server/catgo/workflow/skills/analysis/mace_ni_benchmark/README.md`
- `/Users/jenedithpascasio/CatGO/server/tests/test_mace_ni_benchmark.py`

---

## 13. Approval gate

User explicitly approved all 7 design decisions on 2026-04-18. Proceed to Checkpoint 1 after:
1. Branching off `split-files` as `feature/mace-ni-benchmark` (see §10).
2. Committing this plan as the first commit on the new branch.

## 14. Open question to confirm with colleague

Before PR time, confirm **which branch is CatGo's integration branch**. Candidates:
- `split-files` — where tab-isolation just merged; seems actively maintained
- `dev` — conventional name, may be the real integration branch
- `CatGo-PRO` — looks feature-specific but unclear
- `mlp-vibrations` — may have earlier MLP work worth reviewing before C1 starts

Recommended: ask the colleague, and also check `git log origin/dev..origin/split-files` and `git log origin/mlp-vibrations..origin/split-files` to understand the divergence. If `mlp-vibrations` has earlier MACE-related work that didn't make it into `split-files`, we may want to cherry-pick or rebase before starting C1.
