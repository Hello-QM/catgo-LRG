---
name: catgo-gibbs-pipeline
description: Compute adsorption/reaction Gibbs free energies, free-energy diagrams, and electrochemical overpotentials (HER/ORR/OER/CO2RR/NRR) with VASP. The per-species pipeline is geo_opt → freq → Gibbs; CHE references; ΔG → η. Use whenever a study's target is a FREE energy (not raw DFT energy) — overpotential, free-energy diagram, ΔG of adsorption/reaction, limiting potential. Pairs with the catgo-campaign skill for orchestration.
---

# catgo-gibbs-pipeline — adsorption/reaction free energies & overpotential

> **TL;DR:** G = E_DFT + ZPE − TΔS. Every species in a ΔG needs geo_opt **and** freq.
> Per-species pipeline: `geo_opt → freq → Gibbs`; assemble ΔG → η.

## When to use
Any study whose target is a **free energy** — overpotential η, free-energy diagram, ΔG of
adsorption/reaction, limiting potential (HER/ORR/OER/CO2RR/NRR, adsorption thermo). Raw
geo_opt energies are NOT enough: add ZPE + TΔS from frequencies.

## Core rules (the why)
- **Free energy needs freq.** Skipping freq gives wrong ΔG and wrong η.
- **Per species, pipeline not barrier.** Each species' freq fires as ITS geo_opt
  converges — don't wait for siblings, don't wait for a reminder.
- **Convergence by force**, not dE: `FORCES: max atom` < |EDIFFG|.
- **CHE, not O2:** G(H⁺+e⁻)=½G_H2; derive O/OH from H2O+H2; never compute O2.
- **Gas refs cheap:** Γ-only + `vasp_gam` on `shared`; slabs `vasp_std` + k-mesh on `compute`.

## Bundled resources
- **`catgo freq-inputs`** — build a VASP freq input from a relaxed CONTCAR/POSCAR
  (adsorbate: fix surface, free adsorbate atoms; gas: all free). Runs from ANY directory:
  `catgo freq-inputs --structure <CONTCAR> --out <dir> [--gas | --free-elements O,H]`.
  Wraps `scripts/build_freq_inputs.py` (call the script directly only if `catgo` isn't on
  PATH; resolve it as `<this skill base>/scripts/build_freq_inputs.py`, never a hardcoded
  `~/.claude/...` path).
- `references/method.md` — full thermo + freq setup + CHE/ORR/OER/HER pathway formulas +
  the η definition. Read for the exact equations.
- `examples/orr-pt111.md` — a worked ORR-on-Pt(111) instance (build freq, assemble η).

## Flow
1. geo_opt each species (force-converged) → E.
2. `catgo freq-inputs` from each CONTCAR → submit freq → `catgo freq --mode adsorbed|gas`
   → ZPE + TΔS → G.
3. Assemble ΔG_i along the pathway → U_L = max ΔG_i/e → **η = |1.23 − U_L|**; free-energy
   diagram + ΔG table. (Building blocks: the `vasp-freq`, `gibbs`, `her`, `oer`,
   `energy-diagram` skills.)

In a CatGo campaign, wire this into `plan.md` and let the loop fire freq per species — see
the **catgo-campaign** + **catgo-campaign-loop** skills.
