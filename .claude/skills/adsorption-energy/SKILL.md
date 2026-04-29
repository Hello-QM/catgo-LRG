---
name: adsorption-energy
description: >
  Use when the user asks for adsorption energy, binding energy, or wants to
  compare how strongly a molecule binds to a surface.
---

# Adsorption Energy Calculation

## Theory

```
E_ads = E(slab+adsorbate) - E(slab) - E(adsorbate_gas)
```

- `E_ads < 0`: exothermic adsorption (favorable)
- `E_ads > 0`: endothermic (unfavorable)

### With ZPE Correction

```
dG_ads = G(slab+adsorbate) - G(slab) - G(adsorbate_gas)
```

Where G includes DFT energy + ZPE - TS from Gibbs free energy calculation.

## Three Required Calculations

| System | Description | Notes |
|--------|-------------|-------|
| slab+adsorbate | Adsorbate on surface | geo_opt with fixed bottom layers |
| clean slab | Same slab without adsorbate | geo_opt with same settings |
| adsorbate gas | Isolated molecule in box | geo_opt in large vacuum box (15+ A) |

All three MUST use identical computational settings (ENCUT, EDIFF, k-points
for slab systems; Gamma-only for gas molecule).

## MCP Workflow

### Step 1: Create workflow

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "CO adsorption on Pt(111)"
}}
```

### Step 2: Build and optimize clean slab

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
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_ads",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "clean_slab"}
}}
```

### Step 3: Build and optimize slab + adsorbate

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "C", "position": [2.77, 1.60, 14.0]
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "O", "position": [2.77, 1.60, 15.16]
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_ads",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "slab+CO"}
}}
```

### Step 4: Gas-phase adsorbate

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "molecule", "name": "carbon monoxide"
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_ads",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "ISMEAR": 0,
             "KPOINTS": [1,1,1], "system_name": "CO_gas"}
}}
```

### Step 5: Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_ads"
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("CO adsorption on Pt(111)")

# Clean slab
slab_inp = wf.add_task("structure_input", structure=clean_slab_json)
slab_opt = wf.add_task("geo_opt", structure=slab_inp.output.structure,
                        software="vasp", ENCUT=520)

# Slab + CO
ads_inp = wf.add_task("structure_input", structure=slab_co_json)
ads_opt = wf.add_task("geo_opt", structure=ads_inp.output.structure,
                       software="vasp", ENCUT=520)

# Gas-phase CO (Gamma-only, no smearing)
co_inp = wf.add_task("structure_input", structure=co_gas_json)
co_opt = wf.add_task("geo_opt", structure=co_inp.output.structure,
                      software="vasp", ENCUT=520, ISMEAR=0,
                      KPOINTS=[1, 1, 1])

wf.submit()

# After completion:
# E_ads = ads_opt.output.energy - slab_opt.output.energy - co_opt.output.energy
```

### With ZPE Correction

```python
# Add freq + gibbs for each branch
for task_opt, name, phase in [
    (ads_opt, "slab+CO", "adsorbed"),
    (co_opt, "CO_gas", "gas"),
]:
    frq = wf.add_task("freq", structure=task_opt.output.structure,
                      software="vasp",
                      freeze_mode="layers" if phase == "adsorbed" else "none",
                      freeze_layers=4 if phase == "adsorbed" else 0)
    gib = wf.add_task("gibbs_energy", energy=task_opt.output.energy,
                      frequencies=frq.output.frequencies, phase=phase)
```

## DAG Structure

```
clean_slab     --> geo_opt  ----\
slab+adsorbate --> geo_opt  ----+--> E_ads = E2 - E1 - E3
adsorbate_gas  --> geo_opt  ----/
```

Three independent branches, minimum 3 tasks.

## Comparing Multiple Sites

To compare adsorption at different sites (top, bridge, hollow):

```python
sites = {
    "top":    [2.77, 1.60, 14.0],
    "bridge": [1.39, 2.40, 13.8],
    "hollow": [1.39, 0.80, 13.6],
}

for site_name, pos in sites.items():
    inp = wf.add_task("structure_input", structure=make_ads_slab(pos))
    opt = wf.add_task("geo_opt", structure=inp.output.structure,
                      software="vasp", ENCUT=520,
                      system_name=f"CO_{site_name}")
```

## Common Pitfalls

1. The gas-phase molecule must be in a large box (15+ A vacuum on all sides)
   with Gamma-only k-points and Gaussian smearing (ISMEAR=0).
2. For dissociative adsorption (e.g., O2 --> 2 *O), use the appropriate
   reference: 0.5 * E(O2_gas), not E(O_atom).
3. BSSE (basis set superposition error) is usually negligible for planewave
   DFT but can matter for localized basis sets (CP2K GTH).
4. If comparing different adsorbates, always use the SAME clean slab
   calculation as reference -- do not re-optimize the clean slab for each.
5. Check that the adsorbate did not desorb or migrate to a different site
   during geo_opt by inspecting the final structure.
