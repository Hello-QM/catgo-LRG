# MACE Ni Benchmark — User Guide

End-to-end reproduction of the Kreitz 2021 Ni surface DFT-D3 benchmark
using MACE-MP-0 inside CatGo. One preset, one Run button, six target
quantities with a side-by-side comparison table.

## Quick start

1. In the project dashboard, click **+ New Workflow**.
2. In the workflow editor, click **New from preset → Surface Catalysis →
   UMA Catalysis Tutorial**.
3. The 26-node DAG loads. Click each of the 4 input nodes and load a
   structure:
   - **`Ni bulk (FCC)`** — fcc Ni, a ≈ 3.524 Å (Materials Project `mp-23`)
   - **`H₂ molecule`** — two H atoms, ~0.74 Å separation, 20 Å box
   - **`CO* on Ni(111)`** — NEB reactant (CO adsorbed on a Ni(111) slab)
   - **`C* + O* on Ni(111)`** — NEB product (separated C and O)
4. Click **Run**. In the Run Config dialog, pick **HPC** (GPU, ~10 min)
   or **Local** (CPU, ~1 h).
5. When the workflow reaches all-green, open the project dashboard and
   click the **Benchmark** tab.

## What you get

A single table with six rows, each comparing your MACE result to the
Kreitz 2021 RPBE-D3 reference:

| Quantity | CatGo (MACE) | Kreitz 2021 | Δ | Unit |
|---|---|---|---|---|
| γ(111) | ... | 2.011 | ... | J/m² |
| γ(100) | ... | 2.226 | ... | J/m² |
| γ(110) | ... | 2.153 | ... | J/m² |
| γ(211) | ... | 2.246 | ... | J/m² |
| Wulff fraction (111) | ... | 0.85 | ... | fraction |
| Wulff fraction (100) | ... | 0.12 | ... | fraction |
| E_ads(H) [ZPE-corr] | ... | -0.46 | ... | eV |
| ∂E_ads/∂θ | ... | 0.08 | ... | eV/ML |
| NEB barrier (CO*→C*+O*) | ... | 2.88 | ... | eV |
| ν_imag @ TS | ... | -412 | ... | cm⁻¹ |

Below the table is a reproducibility panel with the MACE checkpoint
SHA-256, torch version, device, host, and wall time from the last MLP
step. Hit **Export CSV** to send the whole thing to a colleague — the
metadata follows the table as comment lines.

## What the preset computes, branch-by-branch

**Branch 1 — Surface energies.** `batch_slab_gen` emits 12 slabs
(4 facets × 3 thicknesses). `surface_energy` does per-facet linear
extrapolation E_slab vs n_atoms → γ(hkl). `wulff_construction` consumes
the four γ values and emits facet area fractions.

**Branch 2 — H adsorption.** A 3×3 Ni(111) slab + one H at the FCC hollow
site. A parallel reference chain computes H₂ gas-phase energy. Both
freq nodes feed ZPE into `adsorption_energy`, which outputs
`E_ads_ZPE_eV = E(slab+H) - E(slab) - 0.5·E(H₂) + dZPE`.

**Branch 3 — Coverage sweep.** 4×4 Ni(111), `batch_coverage_gen` fills
1..5 hollow sites deterministically via pymatgen's `AdsorbateSiteFinder`.
`coverage_analysis` fits E_ads vs θ → slope.

**Branch 4 — NEB.** 3×3 Ni(111) with two manually-positioned endpoints
(CO* ontop, C* + O* at adjacent hollows). `ts_search` runs a 7-image
climbing-image NEB (CI-NEB) with FIRE. A `freq` node at the TS computes
the imaginary-mode frequency — flagged `is_valid_ts: true` only if
exactly one imaginary mode exists above the 20 cm⁻¹ trivial-mode filter.

## Expected differences from DFT-D3

MACE-MP-0 is a foundation model trained on DFT-D3, not a perfect
reproduction of it. Deviations of ~0.1-0.3 (J/m² or eV) are expected
and documented in `SKILL.md`. If you see much larger deviations:

1. Check that the bulk relaxation converged (`fmax < 0.01 eV/Å`).
2. Check that the NEB converged (`neb_converged: true` in the ts_search
   step's result panel).
3. Check that the TS freq has `is_valid_ts: true` — a minimum-energy
   state with 0 imaginary modes means your NEB landed at a wrong image.
4. Check the reproducibility panel — if `mace_torch_version` or
   `model_sha256` differ from what you expect, you may be running a
   stale or fine-tuned model.

## Customizing

The preset is immutable once loaded, but you can edit any node's
parameters before running. Common tweaks:

- **Different MLP:** open any MLP-dispatched node (any `geo_opt` / `freq`
  / `ts_search` with software=mlp), change `model` from MACE to CHGNet
  or M3GNet. The reproducibility panel will record the new model.
- **Denser coverage sweep:** edit the `batch_coverage_gen` node's
  `coverages` param from `[1,2,3,4,5]` to `[1,2,3,4,5,6,8,12,16]`.
- **Thicker slabs:** edit the `batch_slab_gen` node's `combinations`.

## Known limitations

- First run downloads the ~200 MB MACE-MP-0 checkpoint to `~/.cache/mace/`.
  Allow ~2 minutes of one-time cost.
- NEB endpoint placement is manual. The defaults put CO* ontop and a
  C+O "molecule" at a hollow site — you should separate C and O into
  adjacent hollows for Kreitz-comparable numbers.
- The Wulff construction uses a cubic lattice of the shortest slab
  in-plane parameter as the bulk lattice. Area fractions are scale-free
  for cubic systems so this is safe; for non-cubic systems you'd need
  to pass `lattice_constant` explicitly.
- ASE MACE is single-GPU. For multi-GPU, rewrite the preset to use
  LAMMPS + MACE pair style (out of scope for v1).

## Reference

Kreitz, B. et al. "Quantifying the Impact of DFT-D3 on the Prediction
of Surface Properties: A Case Study on Nickel." *ACS Catal.* **2021**,
11, 23, 14611–14625. DOI:
[10.1021/acscatal.1c02988](https://doi.org/10.1021/acscatal.1c02988).
