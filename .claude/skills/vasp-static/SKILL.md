---
name: vasp-static
description: VASP single-point energy calculation. Used standalone, as a pre-step for DOS/band structure, or to evaluate energy at a fixed geometry.
---

# VASP Single Point Calculation

Compute the total energy (and optionally charge density, wavefunction) at a fixed geometry. No ionic relaxation.

## When to Use

1. **After geometry optimization** — get a precise energy at the relaxed geometry with tighter settings
2. **Before DOS calculation** — generate CHGCAR with fine k-mesh for subsequent non-SCF DOS
3. **Before band structure** — generate CHGCAR for non-SCF band calculation
4. **Convergence testing** — test ENCUT, k-points, or other parameters at fixed geometry
5. **Energy evaluation** — compare energies of different configurations without relaxing

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Functional consistency** — must match the functional used in the preceding geo_opt; mixing PBE geometry with SCAN single point introduces systematic errors

🟡 **Recommend confirming:**
- LORBIT (default: 11) — needed for projected DOS; set to 11 for per-atom orbital projections, omit if only total energy is needed
- NEDOS (default: 3001) — increase for DOS analysis to resolve fine features; 301 is sufficient for energy-only calculations
- ISMEAR — use -5 (tetrahedron) for DOS calculations, 0 (Gaussian) for general single points, 1 (Methfessel-Paxton) for metals
- LCHARG / LWAVE — set True if this single point feeds into a subsequent DOS or band structure calculation

🟢 **Safe defaults:**
- NSW = 0 (no ionic relaxation)
- IBRION = -1 (no ionic optimizer)
- EDIFF = 1E-5
- ISMEAR = 0, SIGMA = 0.05

## Basic Single Point

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, single_point

wf = Workflow("Single point energy")
struct = wf.add_task("structure_input", structure=structure_json)
sp = wf.add_task(single_point, structure=struct.output.structure,
                 system_name="TiO2_SP")
wf.submit()
```

**MCP equivalent:**
```
catgo_workflow_engine(action="create", params={"name": "Single point"})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "single_point",
  "software": "vasp",
  "structure": "<json>",
  "system_name": "TiO2_SP"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## After Optimization

Chain a single point after relaxation for a more accurate energy:

```python
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2, system_name="relax")
sp = wf.add_task(single_point, structure=opt.output.structure,
                 ENCUT=600,     # Higher cutoff for precise energy
                 EDIFF=1e-6,    # Tighter SCF convergence
                 system_name="SP_precise")
```

## Pre-DOS Single Point

Generate a converged charge density with a fine k-mesh for subsequent DOS:

```python
sp = wf.add_task(single_point, structure=opt.output.structure,
                 LCHARG=True,    # Write CHGCAR (needed for DOS)
                 LWAVE=True,     # Write WAVECAR (optional, speeds up DOS)
                 ISMEAR=-5,      # Tetrahedron method (accurate DOS)
                 NEDOS=3001,     # Dense energy grid
                 EDIFF=1e-6,     # Tight convergence
                 system_name="SP_for_DOS")
```

## Pre-Band Structure Single Point

Generate CHGCAR for non-SCF band calculation:

```python
sp = wf.add_task(single_point, structure=opt.output.structure,
                 LCHARG=True,    # Write CHGCAR
                 ICHARG=2,       # Self-consistent (generate charge)
                 system_name="SP_for_bands")
```

## Convergence Testing

Test multiple ENCUT values at a fixed geometry:

```python
wf = Workflow("ENCUT convergence")
struct = wf.add_task("structure_input", structure=structure_json)

for encut in [400, 450, 500, 550, 600]:
    wf.add_task(single_point, structure=struct.output.structure,
                ENCUT=encut, system_name=f"ENCUT={encut}")

wf.submit()
```

**MCP equivalent:**
```
catgo_workflow_engine(action="create", params={"name": "ENCUT convergence"})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<json>"
})

# Repeat for each ENCUT value
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "single_point",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "ENCUT": 400,
  "system_name": "ENCUT=400"
})
# ... repeat for 450, 500, 550, 600
```

## Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| NSW | 0 | No ionic steps (fixed geometry) |
| IBRION | -1 | No ionic optimizer |
| EDIFF | 1e-5 | SCF convergence (use 1e-6 for precise energy) |
| NEDOS | 3001 | Number of DOS points (increase for DOS calculations) |
| LCHARG | False | Write CHGCAR (set True for DOS/band pre-calc) |
| LWAVE | False | Write WAVECAR (set True to restart from wavefunction) |
| ISMEAR | 0 | Gaussian smearing (use -5 for DOS with tetrahedron) |
| LORBIT | 11 | Write projected DOS (DOSCAR with per-atom projections) |

## ISMEAR Guidance

| System type | ISMEAR | SIGMA | Notes |
|---|---|---|---|
| Insulator/semiconductor | 0 | 0.05 | Gaussian smearing (default) |
| Metal | 1 | 0.2 | Methfessel-Paxton |
| DOS calculation | -5 | N/A | Tetrahedron with Blochl corrections |
| Molecule in box | 0 | 0.01 | Small sigma, Gamma-only |

**Rule:** ISMEAR=-5 requires at least 3 k-points per direction. Do not use for Gamma-only calculations.

## Output

The single_point task produces:
- `output.energy` — total DFT energy in eV
- `output.structure` — the (unchanged) input structure

## Troubleshooting

| Problem | Fix |
|---|---|
| SCF not converging | Try ALGO=All, increase NELM=400, or AMIX=0.1 |
| Negative NBANDS warning | Increase NBANDS explicitly |
| Memory error | Reduce NCORE, or increase node count |
| Wrong energy for magnetic system | Set ISPIN=2, provide MAGMOM |
