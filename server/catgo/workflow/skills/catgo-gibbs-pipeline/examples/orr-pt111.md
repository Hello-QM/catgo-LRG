# Example — ORR overpotential on Pt(111) (CHE)

A worked instance of the per-species `geo_opt → freq → Gibbs → η` pipeline, as run as a
CatGo md-orchestration campaign (`~/catgo-campaigns/Pt111-ORR`).

## Species (each: geo_opt → freq → G)
- clean Pt(111) 3×3×4 slab (bottom 2 layers fixed) — `compute`/128/`vasp_std`, k 4×4×1
- adsorbates: `*O` (fcc), `*OH` (top), `*OOH` (top), 1/9 ML — same slab settings
- gas references: `H2O`, `H2` — `shared`/32/`vasp_gam`, Γ-only

## Build a freq input (after a geo_opt converges)
All freq are **Γ-only, no NCORE, shared/32, vasp_gam** (cheap + robust; surface frozen):
```
# *OH adsorbate: free the O,H, fix the metal (Γ is the default)
catgo freq-inputs --structure <OH>/CONTCAR --out 04-freq/Pt111_OH_freq \
    --free-elements O,H --ismear 1 --sigma 0.2
# H2O gas reference: all atoms free
catgo freq-inputs --structure <H2O>/CONTCAR --out 04-freq/H2O_freq \
    --gas --ismear 0 --sigma 0.05
```
Submit all freq via the gas job template (`scripts/reference_gas.sb`: shared/32/vasp_gam).

## Assemble η
1. `catgo freq --mode adsorbed` (adsorbates) / `--mode gas` (H2O, H2) → ZPE + TΔS per species.
2. G = E + ZPE − TΔS. CHE: μ_O = G_H2O − G_H2; μ_OH = G_H2O − ½ G_H2; G(H⁺+e⁻) = ½ G_H2.
3. ΔG1..ΔG4 along *OOH→*O→*OH→* ; U_L = max ΔG_i/e ; **η = 1.23 − U_L**.
4. Free-energy diagram + ΔG table → `analysis/`.

## Lessons from the live run
- Judge geo_opt convergence by **`FORCES: max atom` < 0.03**, not by dE (a small dE hid a
  0.2 eV/Å residual force on *OH).
- A crude hand-built `*OOH` gave 3 eV/Å forces that wouldn't relax — rebuild adsorbates with
  physical bond lengths/angles (O–O 1.44, O–H 0.98, ∠OOH ~107°).
- The "kinetic energy error for atom (will be added to EATOM)" OUTCAR line is benign.
