# Gibbs / overpotential — method detail

Deep reference for the `catgo-gibbs-pipeline` skill. Read when you need the exact thermo,
freq setup, or pathway formulas.

## Free energy
G = E_DFT + ZPE − TΔS (+ thermal/pressure terms for gas-phase molecules). Raw geo_opt
energies are NOT free energies — ZPE and TΔS come from vibrational frequencies, so every
species entering a ΔG needs a freq calc on its relaxed geometry.

## Per-species pipeline (auto-advance, not a barrier)
For each species (adsorbate intermediate AND molecular reference):
1. geo_opt → relaxed E (force-converged: `FORCES: max atom` < |EDIFFG|, not just dE).
2. freq (from CONTCAR) → ZPE + TΔS.
3. Gibbs G.
Freq fires as THAT species' geo_opt converges — pipeline per species, don't wait for siblings.

## freq setup
Use `scripts/build_freq_inputs.py`. Key choices (cheap + robust):
- **K = Γ only (1×1×1)** for ALL freq — freq needs only forces, and for an adsorbate the
  surface is frozen, so a dense k-mesh is wasted. Γ ⇒ run on the gamma build `vasp_gam`.
- **No NCORE / NPAR** — IBRION=5 finite differences are most robust with no band
  parallelization (default NCORE=1); NCORE>1 can corrupt the Hessian on some builds.
- **shared node, ~32 cores** — freq is small; don't take an exclusive 128-core node.
- **Adsorbates** — fix all surface atoms, free ONLY the adsorbate atoms (harmonic adsorbate
  modes; surface phonons cancel in ΔG). `IBRION=5 NFREE=2 POTIM=0.015 NSW=1 EDIFF=1e-6`,
  ISMEAR=1/SIGMA=0.2 (metal), ISPIN=2. → `catgo freq --mode adsorbed` → ZPE + TΔS_vib.
- **Molecules** — all atoms free, ISMEAR=0/SIGMA=0.05. → `catgo freq --mode gas` →
  ZPE + thermal + rotational/translational entropy (ideal gas).
- Use real modes only; shift small/imaginary modes per the freq_cutoff convention
  (~50 cm⁻¹).

## Gas-phase references (compute convention)
Small molecules (H2, H2O, O2, CO, …): Γ-point only + the gamma build `vasp_gam` on a
`shared` node (~32 cores) — never an exclusive 128-core node for a few-atom molecule.
Slabs: `vasp_std` + a k-mesh on `compute`.

## CHE references (avoid O2)
Computational Hydrogen Electrode: G(H⁺ + e⁻) = ½ G_H2 at U = 0, pH 0. Each (H⁺ + e⁻)
transfer shifts a state by +eU. Derive O/OH chemical potentials from H2O + H2:
- μ_O  = G_H2O − G_H2
- μ_OH = G_H2O − ½ G_H2
Do NOT compute O2 (triplet / over-binding error) — the whole point of CHE.

## ORR (4e, associative) pathway, U = 0, pH 0
- ΔG1: O2 + * + (H⁺+e⁻) → *OOH     (anchored via 4×1.23 = 4.92 eV total to 2 H2O)
- ΔG2: *OOH + (H⁺+e⁻) → *O + H2O
- ΔG3: *O + (H⁺+e⁻) → *OH
- ΔG4: *OH + (H⁺+e⁻) → * + H2O
With G_state = E + ZPE − TΔS for each adsorbed state, referenced to clean slab + the CHE
potentials. **Limiting potential** U_L = max(ΔG_i)/e; **overpotential** η = 1.23 − U_L.

## OER
Reverse of ORR (water oxidation): same four intermediates, η = max(ΔG_i)/e − 1.23.

## HER
ΔG_H* = G(*H) − G(*) − ½ G_H2. Ideal at ΔG_H* ≈ 0; η descriptor from |ΔG_H*|.

## Outputs
A ΔG_i table, the limiting step, η, and a free-energy diagram (G vs reaction coordinate at
U = 0 and at U = U_L). Write them into the campaign's `analysis/`.
