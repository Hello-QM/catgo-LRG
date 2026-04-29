---
name: bader-charge-analysis
description: >
  Use when the user asks about Bader charge analysis, charge transfer,
  oxidation states from DFT, or electron density partitioning.
---

# Bader Charge Analysis

## Overview

Bader analysis partitions the continuous electron density from DFT into
atomic basins defined by zero-flux surfaces of the density gradient. This
gives physically meaningful atomic charges and charge transfer values.

### What Bader Charges Tell You

- **Charge transfer** between adsorbate and surface
- **Oxidation states** of atoms in a material
- **Electron donation/back-donation** in catalytic bonds
- **Ionic vs covalent character** of bonds

## VASP Settings for Bader Analysis

Bader analysis requires fine-grid charge density output:

```
LAECHG = .TRUE.    # Write core charge density (AECCAR0, AECCAR2)
LCHARG = .TRUE.    # Write valence charge density (CHGCAR)
NGXF, NGYF, NGZF   # Fine FFT grid (2x default, e.g., NGXF=2*NGX)
```

The all-electron charge density is: AECCAR0 + AECCAR2, which is summed
with the Bader code to avoid errors from pseudopotential smoothing.

## MCP Workflow

### Step 1: Single-point with charge output

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_bader",
  "task_type": "single_point",
  "params": {
    "software": "vasp",
    "ENCUT": 520,
    "LAECHG": true,
    "LCHARG": true,
    "PREC": "Accurate",
    "system_name": "charge density"
  }
}}
```

### Step 2: Bader analysis post-processing

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_bader",
  "task_type": "charge_analysis",
  "depends_on": "task_sp",
  "params": {"method": "bader", "system_name": "Bader charges"}
}}
```

### Step 3: Get results

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "get_result", "workflow_id": "wf_bader", "task_id": "task_bader"
}}
```

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "charges", "workflow_id": "wf_bader", "task_id": "task_bader"
}}
```

## Python API

### Basic Bader Analysis

```python
from catgo.workflow import Workflow

wf = Workflow("Bader charge - CO on Pt(111)")

inp = wf.add_task("structure_input", structure=co_pt_json)

# Relax first
opt = wf.add_task("geo_opt",
    structure=inp.output.structure,
    software="vasp", ENCUT=520)

# Single-point with charge density output
sp = wf.add_task("single_point",
    structure=opt.output.structure,
    software="vasp", ENCUT=520,
    LAECHG=True, LCHARG=True, PREC="Accurate")

# Bader post-processing
bader = wf.add_task("charge_analysis",
    chgcar=sp.output.chgcar,
    aeccar0=sp.output.aeccar0,
    aeccar2=sp.output.aeccar2,
    method="bader")

wf.submit()
```

### Charge Transfer Analysis

```python
# Compare charges before and after adsorption
wf = Workflow("Charge transfer analysis")

# Clean slab Bader
slab_sp = wf.add_task("single_point",
    structure=slab_opt.output.structure,
    software="vasp", ENCUT=520, LAECHG=True, LCHARG=True)
slab_bader = wf.add_task("charge_analysis",
    chgcar=slab_sp.output.chgcar,
    aeccar0=slab_sp.output.aeccar0,
    aeccar2=slab_sp.output.aeccar2)

# Slab+adsorbate Bader
ads_sp = wf.add_task("single_point",
    structure=ads_opt.output.structure,
    software="vasp", ENCUT=520, LAECHG=True, LCHARG=True)
ads_bader = wf.add_task("charge_analysis",
    chgcar=ads_sp.output.chgcar,
    aeccar0=ads_sp.output.aeccar0,
    aeccar2=ads_sp.output.aeccar2)

wf.submit()

# After completion:
# dq = q_ads(atom) - q_clean(atom) for each surface atom
# Positive dq = atom lost electrons; Negative dq = atom gained electrons
```

## DAG Structure

```
structure --> geo_opt --> single_point(LAECHG) --> charge_analysis
```

## Output Format

Bader analysis returns per-atom data:

| Field | Description |
|-------|-------------|
| `atom_index` | 0-based atom index |
| `element` | Element symbol |
| `bader_charge` | Electrons in Bader basin |
| `valence_electrons` | POTCAR valence electron count |
| `net_charge` | valence_electrons - bader_charge (+ means cation) |
| `volume` | Bader basin volume (A^3) |

## Interpreting Results

### Common Reference Charges (VASP PAW, valence electrons)

| Element | ZVAL (valence e-) | Typical Net Charge Range |
|---------|-------------------|------------------------|
| O | 6 | -0.8 to -1.4 (oxide) |
| Ti | 4 or 10 | +1.5 to +2.5 (TiO2) |
| Pt | 10 | -0.1 to +0.3 (metallic) |
| C | 4 | -0.5 to +1.0 (varies) |
| H | 1 | +0.4 to +0.6 (on O), -0.3 (on metal) |

### Charge Transfer Upon Adsorption

```
dq_adsorbate = sum(net_charge of adsorbate atoms in slab+ads system)
             - sum(net_charge of same atoms in isolated adsorbate)
```

- dq < 0: adsorbate gains electrons (acceptor, e.g., CO on Pt)
- dq > 0: adsorbate loses electrons (donor, e.g., Na on surface)

## Common Pitfalls

1. Always use LAECHG=.TRUE. to get all-electron charge density.
   Bader analysis on pseudocharge (CHGCAR alone) gives wrong atomic
   charges because core electrons are missing.
2. PREC=Accurate and a fine FFT grid improve Bader basin boundaries.
   Coarse grids can misassign charge near atomic boundaries.
3. Bader charges are NOT formal oxidation states. They are typically
   smaller in magnitude (e.g., Ti in TiO2 shows +2.3, not +4).
4. For charge transfer analysis, use the SAME computational settings
   for the reference and adsorbed systems.
5. The Bader program (Henkelman group) must be available on the HPC.
   CatGo calls it automatically during `charge_analysis` post-processing.
6. For spin-polarized systems, Bader can also partition spin density --
   this gives magnetic moments per atom.
