---
name: co2rr-selectivity
description: >
  Use when the user asks about CO2 reduction reaction (CO2RR), CO2
  electroreduction intermediates, Faradaic efficiency, or selectivity
  toward CO, methanol, methane, formic acid, etc.
---

# CO2RR Pathway and Selectivity Analysis

## Theory

CO2 electroreduction proceeds through multiple intermediates with branching
pathways that determine product selectivity.

### Key Intermediates

| Intermediate | Formula on Surface | Description |
|-------------|-------------------|-------------|
| *COOH | COOH bound via C | First protonation of CO2 |
| *CO | CO bound via C | After *COOH loses OH |
| *CHO | CHO bound via C | Reduction of *CO (toward methanol/methane) |
| *COH | COH bound via C | Alternative *CO reduction |
| *CH2O | CH2O (formaldehyde) | Further reduction |
| *CH3O | CH3O (methoxy) | Toward methanol |
| *CH3OH | CH3OH (methanol) | Final product (desorbs) |
| *OCHO | OCHO bound via O | Toward formic acid (HCOOH) |

### Pathway Branching

```
CO2 --> *COOH --> *CO --> desorbs as CO (2e- product)
                    |
                    +--> *CHO --> *CH2O --> *CH3O --> CH3OH (6e-)
                    |                          |
                    |                          +--> CH4 + *O (8e-)
                    |
                    +--> *COH --> *C --> *CH --> *CH2 --> *CH3 --> CH4 (8e-)

CO2 --> *OCHO --> HCOOH (2e-, formic acid pathway)
```

### Selectivity Descriptor

The branching between CO and further reduction is controlled by:

```
dG(*CHO) - dG(*CO)   or   dG(*COH) - dG(*CO)
```

- If *CO desorption is easier than *CHO formation: product = CO
- If *CHO formation is favorable: product = methanol or methane

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Target product** — CO (2e-) vs CH3OH (6e-) vs CH4 (8e-) vs HCOOH (2e-) determines which intermediates to compute; wrong pathway = wasted compute on irrelevant intermediates
- **Surface choice** — Cu(111) is canonical for beyond-CO products; other metals (Ag, Au) mainly produce CO; surface identity determines selectivity
- **Functional** — must be consistent across all intermediates and gas references; PBE may overbind CO on Cu, consider BEEF-vdW or RPBE for CO2RR

🟡 **Recommend confirming:**
- Selectivity descriptors — include both *COOH and *OCHO first intermediates if studying CO vs formic acid selectivity
- Solvent effects — *COOH and *CHO are stabilized by 0.1-0.3 eV with solvation; implicit (VASPsol) or explicit water molecules improve accuracy
- pH (default: 0) — each proton-transfer step shifts by -0.059*pH eV; alkaline conditions favor CO over further reduction products

🟢 **Safe defaults:**
- Standard CHE model: G(H+ + e-) = 0.5*G(H2)
- Gas references: CO2, H2, H2O, CO (all with phase="gas")
- Atom-balanced free energy steps

## Complete MCP Workflow

### 1. Create workflow and build slab

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "CO2RR on Cu(111)"
}}
```

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Cu", "source": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [1,1,1],
  "min_slab_size": 12.0, "min_vacuum_size": 15.0
}}
```

### 2. For each intermediate, add geo_opt --> freq --> gibbs chain

Example for *COOH:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_co2rr",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "*COOH"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_co2rr",
  "task_type": "freq", "depends_on": "task_cooh_opt",
  "params": {"software": "vasp", "freeze_mode": "layers", "freeze_layers": 4,
             "system_name": "*COOH"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_co2rr",
  "task_type": "gibbs_energy",
  "depends_on": ["task_cooh_opt", "task_cooh_freq"],
  "params": {"phase": "adsorbed", "system_name": "*COOH"}
}}
```

Repeat for: *CO, *CHO, *CH2O, *CH3O, *CH3OH, and clean slab.

### 3. Gas-phase references

```json
{"tool": "catgo_fetch", "arguments": {"action": "molecule", "name": "carbon dioxide"}}
```

Add gas-phase gibbs tasks for: CO2, H2, H2O, CO (all with `phase="gas"`).

### 4. Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_co2rr"
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("CO2RR on Cu(111)")

slab_inp = wf.add_task("structure_input", structure=clean_slab_json)
slab_opt = wf.add_task("geo_opt", structure=slab_inp.output.structure,
                        software="vasp", ENCUT=520)

# All intermediates
intermediates = ["COOH", "CO", "CHO", "CH2O", "CH3O", "CH3OH"]
for ads in intermediates:
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
for mol in ["CO2", "H2", "H2O", "CO"]:
    inp = wf.add_task("structure_input", structure=gas_molecules[mol])
    opt = wf.add_task("geo_opt", structure=inp.output.structure, software="vasp")
    frq = wf.add_task("freq", structure=opt.output.structure, software="vasp")
    gib = wf.add_task("gibbs_energy", energy=opt.output.energy,
                      frequencies=frq.output.frequencies,
                      phase="gas", system_name=f"{mol}(g)")

wf.submit()
```

## Free Energy Diagram

After all gibbs tasks complete, compute the reaction free energy for each step.

**Important:** All G values must be **Gibbs free energies** (from geo_opt + freq +
gibbs_energy chain), NOT raw DFT electronic energies. Using E_DFT instead of G
omits ZPE and entropy, leading to errors of 0.2-0.5 eV per step.

### Atom-Balanced Free Energy Steps (CHE convention)

Using the computational hydrogen electrode: G(H+ + e-) = 0.5 * G(H2) at U=0V.
Each step must balance all atoms (C, O, H) on both sides:

```
Step 1: CO2(g) + H+ + e- --> *COOH
  dG1 = G(*COOH) - G(*) - G(CO2) - 0.5*G(H2)
  Balance: C=1, O=2, H=1 on both sides

Step 2: *COOH + H+ + e- --> *CO + H2O
  dG2 = G(*CO) + G(H2O) - G(*COOH) - 0.5*G(H2)
  Balance: C=1, O=2, H=2 on both sides

Step 3: *CO + H+ + e- --> *CHO
  dG3 = G(*CHO) - G(*CO) - 0.5*G(H2)
  Balance: C=1, O=1, H=1 on both sides

Step 4: *CHO + H+ + e- --> *CH2O
  dG4 = G(*CH2O) - G(*CHO) - 0.5*G(H2)
  Balance: C=1, O=1, H=2 on both sides

Step 5: *CH2O + H+ + e- --> *CH3O
  dG5 = G(*CH3O) - G(*CH2O) - 0.5*G(H2)
  Balance: C=1, O=1, H=3 on both sides

Step 6: *CH3O + H+ + e- --> CH3OH(g) + *
  dG6 = G(CH3OH) + G(*) - G(*CH3O) - 0.5*G(H2)
  Balance: C=1, O=1, H=4 on both sides
```

### pH Correction

At non-zero pH, each proton-transfer step is corrected by:

```
dG_i(pH) = dG_i - 0.059 * pH   (eV, at 298 K)
```

This shifts the free energy of every (H+ + e-) transfer by -0.059 eV per pH unit
(Nernst relation). At pH 0, no correction is needed.

The potential-determining step (PDS) is the step with the largest positive dG.
The limiting potential is U_L = -max(dG_i) / e.

## DAG Structure

```
clean_slab --> geo_opt
*COOH  --> geo_opt --> freq --> gibbs    \
*CO    --> geo_opt --> freq --> gibbs     |
*CHO   --> geo_opt --> freq --> gibbs     |-- all parallel
*CH2O  --> geo_opt --> freq --> gibbs     |
*CH3O  --> geo_opt --> freq --> gibbs     |
*CH3OH --> geo_opt --> freq --> gibbs    /
CO2(g) --> geo_opt --> freq --> gibbs (gas)
H2(g)  --> geo_opt --> freq --> gibbs (gas)
H2O(g) --> geo_opt --> freq --> gibbs (gas)
CO(g)  --> geo_opt --> freq --> gibbs (gas)
```

Total: ~31 tasks. All branches are independent.

## Common Pitfalls

1. Cu(111) is the canonical CO2RR catalyst -- Cu uniquely binds *CO strongly
   enough for further reduction but not so strongly that it poisons.
2. *COOH and *OCHO are competing first intermediates. Include both if studying
   selectivity between CO/methanol vs formic acid pathways.
3. Use dipole corrections (LDIPOL=.TRUE., IDIPOL=3 in VASP) for charged
   adsorbates on metallic slabs -- CO2RR intermediates have significant
   dipole moments.
4. Solvation corrections (~0.1-0.3 eV stabilization for *COOH, *CHO) are
   important for quantitative accuracy. Add explicit water molecules or use
   implicit solvation (VASPsol) if available.
5. For selectivity studies, the relative energies between competing
   intermediates matter more than absolute values -- ensure consistent
   computational settings across all calculations.
