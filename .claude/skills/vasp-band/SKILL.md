---
name: vasp-band
description: VASP band structure calculation. Two-step workflow with SCF charge density followed by non-SCF band calculation along high-symmetry k-path.
---

# VASP Band Structure Calculation

Compute electronic band structure along high-symmetry k-point paths. Requires a two-step process: self-consistent charge density, then non-SCF calculation along the k-path.

## Why Two Steps?

1. **Single point (SCF)** — compute self-consistent charge density with a uniform k-mesh
2. **Band calculation (non-SCF)** — read the converged CHGCAR and compute eigenvalues along the high-symmetry k-path without updating the charge density

This separation is necessary because the high-symmetry k-path does not provide uniform Brillouin zone sampling needed for SCF convergence.

## Full Band Structure Workflow

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, single_point

wf = Workflow("TiO2 band structure")
struct = wf.add_task("structure_input", structure=structure_json)

# Step 1: Optimize (skip if already relaxed)
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=3, system_name="relax")

# Step 2: SCF single point to generate CHGCAR
scf = wf.add_task(single_point, structure=opt.output.structure,
                  LCHARG=True,     # Write CHGCAR
                  EDIFF=1e-6,      # Tight convergence
                  system_name="SCF")

# Step 3: Non-SCF band calculation
band = wf.add_task(single_point, structure=opt.output.structure,
                   ICHARG=11,       # Read CHGCAR, do not update
                   LORBIT=11,       # Projected band character
                   LCHARG=False,
                   LWAVE=False,
                   kpath_mode="auto",  # Auto-detect high-symmetry path
                   kpath_density=40,   # Points per segment
                   system_name="bands")

wf.submit()
```

## MCP Workflow

```
catgo_workflow_engine(action="create", params={"name": "Band structure"})

# Input structure
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<json>"
})

# SCF single point
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "single_point",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "LCHARG": true,
  "EDIFF": 1e-6,
  "system_name": "SCF"
})

# Non-SCF band calculation
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "single_point",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "ICHARG": 11,
  "LORBIT": 11,
  "kpath_mode": "auto",
  "kpath_density": 40,
  "system_name": "bands"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## High-Symmetry K-Path

### Automatic Path Detection

Set `kpath_mode="auto"` to let the engine detect the Bravais lattice and generate the standard k-path. This works for most crystal systems.

### Manual K-Path

For custom paths, specify k-points explicitly:

```python
band = wf.add_task(single_point, structure=opt.output.structure,
                   ICHARG=11,
                   kpath_mode="manual",
                   kpath_points={
                       "G": [0.0, 0.0, 0.0],
                       "X": [0.5, 0.0, 0.0],
                       "M": [0.5, 0.5, 0.0],
                       "G2": [0.0, 0.0, 0.0],
                       "R": [0.5, 0.5, 0.5],
                   },
                   kpath_segments=["G-X", "X-M", "M-G2", "G2-R"],
                   kpath_density=40,
                   system_name="bands")
```

### Common K-Paths by Crystal System

| System | Path | Example |
|---|---|---|
| FCC | G-X-W-K-G-L-U-W-L-K | Cu, Al, Pt |
| BCC | G-H-N-G-P-H | Fe, W, Cr |
| HCP | G-M-K-G-A-L-H-A | Ti, Ru, Co |
| Tetragonal | G-X-M-G-Z-R-A-Z | TiO2 rutile |
| Simple cubic | G-X-M-G-R-X | SrTiO3 |

## Key Parameters

| Parameter | Value | Purpose |
|---|---|---|
| ICHARG | 11 | Read CHGCAR, non-self-consistent |
| LORBIT | 11 | Atom- and orbital-projected bands |
| NBANDS | auto | Number of bands (increase for unoccupied states) |
| LCHARG | False | Do not overwrite CHGCAR from SCF step |
| LWAVE | False | Do not write WAVECAR (saves disk) |
| kpath_density | 40 | K-points per segment (more = smoother bands) |

## Spin-Polarized Band Structure

For magnetic systems:

```python
scf = wf.add_task(single_point, structure=s,
                  LCHARG=True, ISPIN=2,
                  MAGMOM="2*5.0 4*0.6",
                  system_name="SCF_spin")

band = wf.add_task(single_point, structure=s,
                   ICHARG=11, ISPIN=2, LORBIT=11,
                   kpath_mode="auto", kpath_density=40,
                   system_name="bands_spin")
```

## Hybrid Functional Band Structure (HSE06)

HSE06 band structure is expensive but more accurate for band gaps:

```python
scf = wf.add_task(single_point, structure=s,
                  LCHARG=True, LHFCALC=True, HFSCREEN=0.2,
                  AEXX=0.25, ALGO="Damped", TIME=0.4,
                  system_name="SCF_HSE")

band = wf.add_task(single_point, structure=s,
                   ICHARG=11, LHFCALC=True, HFSCREEN=0.2,
                   AEXX=0.25, ALGO="Damped", TIME=0.4,
                   kpath_mode="auto", kpath_density=20,
                   system_name="bands_HSE")
```

**Note:** HSE band calculations are 10-100x more expensive than PBE. Use a lower kpath_density (20) and fewer NBANDS.

## Combined DOS + Band Structure

Run both from the same SCF calculation:

```python
scf = wf.add_task(single_point, structure=opt.output.structure,
                  LCHARG=True, EDIFF=1e-6, system_name="SCF")

# DOS branch
dos_sp = wf.add_task(single_point, structure=opt.output.structure,
                     ISMEAR=-5, NEDOS=3001, LORBIT=11,
                     system_name="DOS")

# Band branch
band = wf.add_task(single_point, structure=opt.output.structure,
                   ICHARG=11, LORBIT=11,
                   kpath_mode="auto", kpath_density=40,
                   system_name="bands")
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Bands look wrong / discontinuous | CHGCAR from SCF may be on different k-mesh. Ensure SCF used uniform mesh |
| Band gap too small (PBE) | Expected — PBE underestimates gaps. Use HSE06 for accurate gaps |
| Missing unoccupied bands | Increase NBANDS (default may cut off conduction bands) |
| ICHARG=11 error | CHGCAR must exist from SCF step. Check SCF completed with LCHARG=True |
| Very slow HSE | Normal — reduce kpath_density, reduce NBANDS, use more nodes |
