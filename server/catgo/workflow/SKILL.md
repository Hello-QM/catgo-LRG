---
name: catgo-workflow
description: Create and manage computational chemistry workflows with CatGo. Supports VASP, CP2K, ORCA, MLP, LAMMPS. Build OER/HER/CO2RR workflows, geometry optimization, frequency analysis, Gibbs energy calculations.
---

# CatGo Workflow Skill

## Quick Start — Python API

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

wf = Workflow("RuO2 OER")

# Input structure
slab = wf.add_task("structure_input", structure=structure_json)

# Geometry optimization → Frequency → Gibbs Energy
opt = wf.add_task(geo_opt, structure=slab.output.structure, ENCUT=520, system_name="*OH")
frq = wf.add_task(freq, structure=opt.output.structure, system_name="*OH",
                   freeze_mode="layers", freeze_layers=4)
gib = wf.add_task(gibbs_energy, energy=opt.output.energy,
                   frequencies=frq.output.frequencies, system_name="*OH")

wf.submit()  # Engine picks it up automatically
```

> **HPC Confirmation Gate:** By default, HPC tasks pause at `PENDING_REVIEW` after local preprocessing completes, so users can verify structures and parameters before spending HPC resources. Users confirm via the frontend "Confirm & Submit" button (per-task or "Confirm All"). To skip this gate, call `wf.submit(auto_submit=True)`.
>
> **HPC Confirmation Required:** Before calling `wf.submit()` or `catgo_workflow_engine(action="submit")`, you MUST ask the user which HPC cluster to use and confirm job parameters (`partition`, `account`, `walltime`, `ntasks`). These can be set per-task via `add_task` params. Never submit without user confirmation.

## Available Task Types

### HPC Calculations
- `geo_opt` — Geometry optimization (VASP/CP2K/ORCA/MLP)
- `single_point` — Single point energy (VASP/CP2K/ORCA)
- `freq` — Vibrational frequencies (VASP/CP2K/ORCA)
- `cell_opt` — Cell optimization (VASP/CP2K)
- `md` — Molecular dynamics (VASP/CP2K/LAMMPS/MLP)
- `ts_search` — Transition state search (Sella/ORCA NEB-TS)

### Local Analysis
- `gibbs_energy` — G = E_DFT + ZPE - TS
- `free_energy_diagram` — Plot reaction energy diagram
- `dos_analysis` — Density of states analysis
- `charge_analysis` — Bader charge analysis

### Structure Building
- `structure_input` — Provide input structure
- `slab_gen` — Generate surface slab
- `adsorbate_place` — Place adsorbate on surface

## Key Parameters

### VASP
- `software="vasp"`, `ENCUT`, `EDIFF`, `EDIFFG`, `NSW`, `ISIF`, `IBRION`
- `ISMEAR`, `SIGMA`, `ISPIN`, `NCORE`, `KPAR`

### Frequency
- `freeze_mode`: "none", "layers", "z_range", "element", "indices", "manual"
- `freeze_layers`: number of bottom layers to freeze
- `freeze_z_below`: freeze atoms below this z coordinate (Angstrom)

### Gibbs Energy
- `phase`: "adsorbed" (harmonic) or "gas" (ideal gas)
- `temperature`: K (default 298.15)
- `freq_cutoff`: cm-1 (default 50, for adsorbed phase)

## Output References

Connect tasks by passing `.output.key`:
```python
opt.output.structure   # optimized structure
opt.output.energy      # DFT energy (eV)
frq.output.frequencies # vibrational frequencies
frq.output.zpe         # zero-point energy
gib.output.gibbs       # Gibbs free energy
```

## Workflow Patterns

### OER Overpotential
```python
for ads in ["OH", "O", "OOH"]:
    opt = wf.add_task(geo_opt, structure=slab.output.structure,
                      system_name=f"*{ads}")
    frq = wf.add_task(freq, structure=opt.output.structure,
                      freeze_mode="layers", freeze_layers=4)
    gib = wf.add_task(gibbs_energy, energy=opt.output.energy,
                      frequencies=frq.output.frequencies, phase="adsorbed")
```

### Convergence Test
```python
for encut in [400, 500, 600, 700]:
    wf.add_task(single_point, structure=struct.output.structure,
                ENCUT=encut, system_name=f"ENCUT={encut}")
```
