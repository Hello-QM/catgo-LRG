---
name: her-overpotential
description: >
  Use when the user asks about HER (hydrogen evolution reaction), hydrogen
  adsorption free energy, or volcano plot descriptor for HER catalysts.
---

# HER Overpotential Calculation

## Theory

The hydrogen evolution reaction has a single key intermediate:

```
* + H+ + e- --> *H    (Volmer step)
*H + H+ + e- --> H2   (Heyrovsky step)
   or
2 *H --> H2            (Tafel step)
```

### Sabatier Criterion

The optimal HER catalyst has:

```
dG_H* = G(*H) - G(*) - 0.5 * G(H2) ~ 0 eV
```

- dG_H* < 0: H binds too strongly (poisoned surface)
- dG_H* > 0: H binds too weakly (low coverage, slow Volmer)
- dG_H* ~ 0: optimal (top of volcano plot)

### pH Correction

At non-zero pH, the proton-transfer step is corrected by:

```
dG_H*(pH) = dG_H* - 0.059 * pH   (eV, at 298 K)
```

This shifts the free energy of the (H+ + e-) transfer by -0.059 eV per pH unit
(Nernst relation). At pH 0, no correction is needed.

### Overpotential

```
eta_HER = |dG_H*| / e
```

A perfect catalyst has eta_HER = 0 V. Pt(111) gives dG_H* ~ -0.09 eV.

**Important:** All G values must be **Gibbs free energies** (from geo_opt + freq +
gibbs_energy chain), NOT raw DFT electronic energies. Using E_DFT instead of G
omits ZPE and entropy, leading to errors of ~0.2 eV.

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Surface choice** — Miller index and termination determine H binding site and dG_H*; e.g., Pt(111) fcc hollow vs MoS2 S-edge give very different results
- **Functional** — must be consistent between *H slab, clean slab, and gas-phase H2; PBE vs SCAN can shift dG_H* by 0.1-0.3 eV
- **Competing reactions** — on surfaces active for OER/ORR, H adsorption may compete; always check if HER or OER dominates at the operating potential

🟡 **Recommend confirming:**
- Coverage effects — at high H coverage, lateral interactions shift dG_H*; consider testing 1/4 ML vs 1/2 ML vs 1 ML
- Zero-point energy correction — ZPE contributes ~0.04 eV to dG_H*; always include freq + gibbs_energy chain rather than using raw DFT energies
- Adsorption site — test ontop, bridge, and hollow; report the most stable site (lowest |dG_H*|)

🟢 **Safe defaults:**
- Single intermediate (*H)
- dG_H* = G(*H) - G(*) - 0.5*G(H2)
- eta_HER = |dG_H*| / e

## MCP Workflow

### 1. Create workflow

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "HER on Pt(111)"
}}
```

### 2. Build structures

Fetch bulk, cut slab, place H adsorbate:

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Pt", "source": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [1,1,1],
  "min_slab_size": 12.0, "min_vacuum_size": 15.0
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "H",
  "position": [2.77, 1.60, 14.2]
}}
```

### 3. Clean slab branch

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_her",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "clean_slab"}
}}
```

### 4. *H branch: geo_opt --> freq --> gibbs

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_her",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "*H"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_her",
  "task_type": "freq", "depends_on": "task_h_opt",
  "params": {"software": "vasp", "freeze_mode": "layers", "freeze_layers": 4,
             "system_name": "*H"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_her",
  "task_type": "gibbs_energy",
  "depends_on": ["task_h_opt", "task_h_freq"],
  "params": {"phase": "adsorbed", "system_name": "*H"}
}}
```

### 5. Gas-phase H2 reference

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_her",
  "task_type": "gibbs_energy",
  "depends_on": ["task_h2_opt", "task_h2_freq"],
  "params": {"phase": "gas", "system_name": "H2(g)"}
}}
```

### 6. Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_her"
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("HER on Pt(111)")

# Clean slab
slab_inp = wf.add_task("structure_input", structure=clean_slab_json)
slab_opt = wf.add_task("geo_opt", structure=slab_inp.output.structure,
                        software="vasp", ENCUT=520)

# *H on slab
h_inp = wf.add_task("structure_input", structure=slab_h_json)
h_opt = wf.add_task("geo_opt", structure=h_inp.output.structure,
                     software="vasp", ENCUT=520)
h_frq = wf.add_task("freq", structure=h_opt.output.structure,
                     software="vasp", freeze_mode="layers", freeze_layers=4)
h_gib = wf.add_task("gibbs_energy", energy=h_opt.output.energy,
                     frequencies=h_frq.output.frequencies, phase="adsorbed")

# Gas-phase H2
h2_inp = wf.add_task("structure_input", structure=h2_json)
h2_opt = wf.add_task("geo_opt", structure=h2_inp.output.structure,
                      software="vasp")
h2_frq = wf.add_task("freq", structure=h2_opt.output.structure,
                      software="vasp")
h2_gib = wf.add_task("gibbs_energy", energy=h2_opt.output.energy,
                      frequencies=h2_frq.output.frequencies, phase="gas")

wf.submit()
```

## DAG Structure

```
clean_slab --> geo_opt
*H   --> geo_opt --> freq --> gibbs_energy (adsorbed)
H2   --> geo_opt --> freq --> gibbs_energy (gas)
```

Three independent branches, 7 total tasks.

## Interpreting Results

| dG_H* (eV) | Interpretation | Action |
|-------------|---------------|--------|
| -0.5 to -0.1 | Strong binding, decent catalyst | May need surface modification |
| -0.1 to +0.1 | Near optimal (volcano peak) | Excellent HER catalyst |
| +0.1 to +0.5 | Weak binding, moderate activity | Consider alloying or doping |
| > +0.5 | Too weak, poor HER catalyst | Different material needed |

## Adsorption Sites for H

| Surface Type | Preferred H Site | Typical dG_H* |
|-------------|-----------------|----------------|
| Pt(111) | fcc hollow | -0.09 eV |
| MoS2 edge | S-edge top | +0.08 eV |
| Graphene + N-doped | C adjacent to N | varies |

## Common Pitfalls

1. H is small -- use tight EDIFFG (-0.01 eV/A) to ensure proper relaxation.
2. Only freeze bottom slab layers in freq, not the H atom itself.
3. For alloy surfaces, test multiple adsorption sites (top, bridge, hollow)
   and report the most stable one (lowest dG_H*).
4. Always verify H does not migrate subsurface during geo_opt -- check the
   final structure with `catgo_view`.
5. For MoS2 and 2D materials, the "slab" is the monolayer itself with vacuum.
   Set `freeze_layers=0` and use `freeze_mode="none"` in freq.
