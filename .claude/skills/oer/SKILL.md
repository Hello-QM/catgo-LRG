---
name: oer-overpotential
description: >
  Use when the user asks about OER (oxygen evolution reaction) overpotential,
  water oxidation catalysis, or the 4-electron water splitting pathway on a
  surface catalyst.
---

# OER Overpotential Calculation

## Theory: 4-Electron Pathway

```
* + H2O --> *OH  + H+ + e-    (step 1)
*OH      --> *O   + H+ + e-    (step 2)
*O + H2O --> *OOH + H+ + e-   (step 3)
*OOH     --> * + O2 + H+ + e- (step 4)
```

### Free Energy Steps

```
dG1 = G(*OH)  - G(*)  - G(H2O) + 0.5*G(H2)
dG2 = G(*O)   - G(*OH) + 0.5*G(H2)
dG3 = G(*OOH) - G(*O)  - G(H2O) + 0.5*G(H2)
dG4 = 4.92    - dG1 - dG2 - dG3
```

Where 4.92 eV = 2 * G(H2O) - 2 * G(H2) (thermodynamic water splitting).

### pH Correction

At non-zero pH, each proton-transfer step is corrected by:

```
dG_i(pH) = dG_i - 0.059 * pH   (eV, at 298 K)
```

This shifts the free energy of every (H+ + e-) transfer by -0.059 eV per pH unit
(Nernst relation). At pH 0, no correction is needed. At pH 14 (alkaline OER),
each step shifts by -0.83 eV.

### Overpotential

```
eta_OER = max(dG1, dG2, dG3, dG4) / e - 1.23 V
```

The potential-determining step (PDS) is whichever step has the largest dG.

**Important:** All G values must be **Gibbs free energies** (from geo_opt + freq +
gibbs_energy chain), NOT raw DFT electronic energies. Using E_DFT instead of G
omits ZPE and entropy, leading to errors of 0.2-0.5 eV per step.

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Surface choice** — Miller index and termination determine active sites; e.g., RuO2(110) vs (100) have different CUS site geometries and overpotentials
- **Functional** — PBE vs SCAN vs PBE+U; must be consistent across ALL intermediates (*OH, *O, *OOH) and the clean slab; mixing functionals invalidates dG values
- **ISPIN** — must be 2 for magnetic oxide catalysts (Co3O4, NiFe2O4, etc.); non-spin-polarized calculations give qualitatively wrong adsorption energies

🟡 **Recommend confirming:**
- Solvation correction — implicit solvation (VASPsol) or explicit water stabilizes *OH and *OOH by ~0.1-0.3 eV; important for quantitative accuracy
- Dipole correction (LDIPOL=.TRUE., IDIPOL=3) — corrects spurious electrostatic interactions for asymmetric slabs with polar adsorbates
- pH value (default: 0) — each step shifts by -0.059*pH eV; alkaline OER (pH 14) shifts each step by -0.83 eV

🟢 **Safe defaults:**
- 4-electron mechanism (*OH, *O, *OOH intermediates)
- dG4 = 4.92 - dG1 - dG2 - dG3 (thermodynamic constraint)
- CHE reference: G(H+ + e-) = 0.5 * G(H2) at U=0V

## Reference Energies

| Species | How to Obtain |
|---------|---------------|
| G(H2) | Gas-phase H2: geo_opt + freq with `phase="gas"` |
| G(H2O) | Gas-phase H2O: geo_opt + freq with `phase="gas"` |
| G(*) | Clean slab: geo_opt only (no freq needed if slab is rigid reference) |

Using the computational hydrogen electrode (CHE): G(H+ + e-) = 0.5 * G(H2) at U=0V.

## Complete MCP Workflow

### 1. Create workflow

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "OER on RuO2(110)"
}}
```

### 2. Build slab + adsorbate structures

For each intermediate (*OH, *O, *OOH), build the structure:

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [1,1,0], "min_slab_size": 12.0,
  "min_vacuum_size": 15.0
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "O", "position": [4.2, 3.1, 14.5]
}}
```

### 3. For each intermediate, add: geo_opt --> freq --> gibbs_energy

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_oer",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "*OH"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_oer",
  "task_type": "freq", "depends_on": "task_oh_opt",
  "params": {"software": "vasp", "freeze_mode": "layers", "freeze_layers": 4,
             "system_name": "*OH"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_oer",
  "task_type": "gibbs_energy", "depends_on": ["task_oh_opt", "task_oh_freq"],
  "params": {"phase": "adsorbed", "system_name": "*OH"}
}}
```

Repeat for *O and *OOH intermediates.

### 4. Add gas-phase references (H2, H2O)

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "molecule", "name": "water"
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_oer",
  "task_type": "gibbs_energy", "depends_on": ["task_h2o_opt", "task_h2o_freq"],
  "params": {"phase": "gas", "system_name": "H2O(g)"}
}}
```

### 5. Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_oer"
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("OER on RuO2(110)")

# Clean slab
slab_inp = wf.add_task("structure_input", structure=clean_slab_json)
slab_opt = wf.add_task("geo_opt", structure=slab_inp.output.structure,
                        software="vasp", ENCUT=520)

# Each intermediate: OH, O, OOH
for ads in ["OH", "O", "OOH"]:
    inp = wf.add_task("structure_input", structure=adsorbate_slabs[ads])
    opt = wf.add_task("geo_opt", structure=inp.output.structure,
                      software="vasp", ENCUT=520, system_name=f"*{ads}")
    frq = wf.add_task("freq", structure=opt.output.structure,
                      software="vasp", freeze_mode="layers", freeze_layers=4,
                      system_name=f"*{ads}")
    gib = wf.add_task("gibbs_energy", energy=opt.output.energy,
                      frequencies=frq.output.frequencies,
                      phase="adsorbed", system_name=f"*{ads}")

# Gas-phase references
for mol, name in [("H2", "H2(g)"), ("H2O", "H2O(g)")]:
    inp = wf.add_task("structure_input", structure=gas_molecules[mol])
    opt = wf.add_task("geo_opt", structure=inp.output.structure,
                      software="vasp", system_name=name)
    frq = wf.add_task("freq", structure=opt.output.structure,
                      software="vasp", system_name=name)
    gib = wf.add_task("gibbs_energy", energy=opt.output.energy,
                      frequencies=frq.output.frequencies,
                      phase="gas", system_name=name)

wf.submit()
```

## DAG Structure

```
clean_slab --> geo_opt
*OH  --> geo_opt --> freq --> gibbs
*O   --> geo_opt --> freq --> gibbs
*OOH --> geo_opt --> freq --> gibbs
H2   --> geo_opt --> freq --> gibbs (gas)
H2O  --> geo_opt --> freq --> gibbs (gas)
```

Total: ~15 tasks. The 5 branches are independent and run in parallel.

## Common Pitfalls

1. Always use the same ENCUT, EDIFF, k-points for ALL intermediates and the
   clean slab. Inconsistent settings cause systematic errors in dG.
2. OOH is weakly bound -- use tight EDIFFG (-0.02 eV/A) and check it does
   not desorb during optimization.
3. Gas-phase molecules must use `phase="gas"` in gibbs_energy.
4. The clean slab reference does not need freq if you treat it as a rigid reference.
   But including freq improves accuracy for flexible substrates.
5. For oxides (RuO2, IrO2), the slab itself already contains O atoms --
   ensure adsorbate placement does not overlap with lattice oxygen.
