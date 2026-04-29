---
name: mace-ni-benchmark
description: >
  Use when the user asks to reproduce the Kreitz 2021 Ni surface benchmark,
  run the MACE Ni benchmark, or compare a machine-learning potential (MACE,
  CHGNet, M3GNet) against DFT-D3 surface-science references. Invokes the
  "UMA Catalysis Tutorial" preset (template key `uma_catalysis_screening`).
---

# MACE Ni Benchmark — Kreitz 2021 Reproduction

Reproduces six Ni surface DFT-D3 target quantities end-to-end with
MACE-MP-0, on a single Ni bulk source, in one workflow.

## When to invoke

Trigger phrases (any of):
- "reproduce Kreitz 2021 Ni benchmark"
- "run the MACE Ni benchmark"
- "benchmark MACE against DFT-D3 for Ni"
- "validate MLP on Ni surfaces"

Also invoke when the user asks to compute *multiple* of the six quantities
below for Ni at once — one preset is cheaper than six separate workflows.

## The six target quantities

| # | Quantity | Source node | Result key |
|---|---|---|---|
| 1 | γ(111), γ(100), γ(110), γ(211) | `surface_energy` | `per_facet[hkl].gamma_J_per_m2` |
| 2 | Wulff facet area fractions | `wulff_construction` | `area_fractions[hkl]` |
| 3 | H adsorption energy on Ni(111) FCC hollow (ZPE-corrected) | `adsorption_energy` | `E_ads_ZPE_eV` |
| 4 | Coverage slope ∂E_ads/∂θ (1,2,4,8,16 H on 4×4 Ni(111)) | `coverage_analysis` | `fit.slope` |
| 5 | CO* ↔ C* + O* NEB barrier | `ts_search` (`mlp_neb`) | `activation_barrier_kcal_mol` |
| 6 | TS imaginary-mode frequency | `freq` (`mlp_vibrations`) | `dominant_imag_freq_cm` (with `is_valid_ts` flag) |

All six are viewable side-by-side in the project dashboard's "Benchmark"
tab once any workflow derived from `uma_catalysis_screening` (or with a
matching name) is present in the project.

## How to invoke

### Option A — UI (recommended)

In the Workflow Editor, click **New from preset → Surface Catalysis →
UMA Catalysis Tutorial**. A 26-node DAG loads. The template is defined
in `src/lib/workflow/graph-model.ts::uma_catalysis_screening`.

After it loads, the user must load structures into 4 input nodes:
1. `Ni bulk (FCC)` — fcc Ni, a ≈ 3.524 Å (Materials Project `mp-23`)
2. `H₂ molecule` — two H atoms ~0.74 Å apart in a 20 Å box
3. `CO* on Ni(111)` — NEB reactant (CO adsorbed on a 3×3 Ni(111) slab)
4. `C* + O* on Ni(111)` — NEB product (C and O separately adsorbed)

### Option B — Manual DAG build (not recommended)

Rebuilding the 26-node DAG by hand costs ~2x the effort and always drifts
from the defaults tested against MACE-MP-0 medium. Only do this if the
user needs a custom variant (e.g. different slab supercell, or a
non-cubic/non-Ni system).

## Expected deviations (MACE-MP-0 vs RPBE-D3)

| Quantity | Typical \|CatGo − Kreitz\| | Notes |
|---|---|---|
| γ(hkl) | ~0.1 J/m² | γ(111) tends to be ~0.05 J/m² higher |
| Wulff fractions | < 0.05 | Dominant (111) facet rank is preserved |
| E_ads(H, ZPE) | ~0.1 eV | MACE-MP-0 slightly overbinds H |
| Coverage slope | ~0.03 eV/ML | Sign (repulsive) should match |
| NEB barrier | ~0.2 eV | Largest single deviation |
| ν_imag | ~50 cm⁻¹ | Sign must be negative (imaginary) |

If deviations are much larger than these ranges, check:
- Did the bulk opt converge? (`fmax < 0.05 eV/Å` with `relax_cell: true`)
- Did NEB converge to the expected CI image? (`neb_converged: true`)
- Is `is_valid_ts: true` on the freq step at the TS? (Exactly one
  imaginary mode above the 20 cm⁻¹ trivial-mode filter.)

## Defaults worth preserving

- `software: mlp`, `model: MACE`, `device: auto` → uses MACE-MP-0 medium
  via the default `mace_mp("medium", default_dtype="float64")` path.
  Checkpoint auto-downloads to `~/.cache/mace/` on first run
  (~200 MB, ~2 min).
- Vibrations freeze the Ni slab and vibrate the adsorbate only
  (`freeze_mode: layers`, `freeze_layers: 2`, `freeze_invert: false`) →
  ~20× cheaper freqs without losing ZPE accuracy. Note: `freeze_invert`
  inverts the set of atoms ASE displaces, so `false` here means the
  `frozen` set (bottom 2 Ni layers) is actually frozen and everything
  else vibrates — the standard catalysis setup. `true` would vibrate
  only the bottom 2 Ni layers (wrong for ZPE).
- NEB: 8 images, `climb: true`, FIRE optimizer, `fmax: 0.05 eV/Å`.
- Coverage sweep: 1,2,4,8,16 H on 4×4 hollow-site filling.

## Reproducibility

Every MLP-dispatched step writes `metadata.json` (captured via the C1
footer in `server/workflow/engines/mlp.py`) into `result_json.metadata`:

```json
{
  "mace_torch_version": "0.3.15",
  "torch_version": "2.10.0",
  "mace_model": "mace-mp-0-medium",
  "model_sha256": null,
  "device": "cuda:0" | "cpu",
  "gpu_name": "...",
  "wall_time_s": 12.3,
  "host": "...",
  "timestamp": "..."
}
```

The Benchmark tab surfaces the latest MLP step's metadata panel. Users
export CSV from the same tab to share the full 6-row table with the
metadata footer included as RFC-4180-escaped comment lines.

## Related skills

- `structure/slab/` — slab generation internals
- `adsorption/` — the general E_ads formula this preset specializes
- `oer/`, `her/` — if the user wants surface reactivity trends on top of γ(hkl)
