---
name: dos-analysis
description: >
  Use when the user asks about density of states (DOS), projected DOS (PDOS),
  d-band center, spin-resolved DOS, or electronic structure analysis from
  completed DFT calculations.
---

# DOS and Electronic Structure Analysis

## Overview

Density of states (DOS) analysis extracts electronic structure information
from completed DFT calculations. Key quantities:

- **Total DOS**: overall electronic structure, band gap identification
- **PDOS**: orbital-resolved contributions from specific atoms
- **d-band center**: catalytic activity descriptor (higher = stronger binding)
- **Spin-resolved DOS**: magnetic ordering, spin polarization

## MCP Tool: catgo_analyze

### Total DOS

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "dos",
  "workflow_id": "wf_abc",
  "task_id": "task_sp",
  "dos_type": "total"
}}
```

### Projected DOS (PDOS)

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "dos",
  "workflow_id": "wf_abc",
  "task_id": "task_sp",
  "dos_type": "projected",
  "atom_indices": [0, 1, 2, 3],
  "orbitals": ["d"]
}}
```

### d-Band Center

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "dos",
  "workflow_id": "wf_abc",
  "task_id": "task_sp",
  "dos_type": "dband",
  "atom_indices": [0, 1, 2, 3]
}}
```

Returns:
- `d_band_center`: energy relative to Fermi level (eV)
- `d_band_width`: standard deviation of d-band (eV)
- `d_band_filling`: fraction of d-band occupied (0-1)

## Workflow for DOS Analysis

DOS requires a completed single_point or geo_opt calculation with
appropriate VASP settings.

### VASP Settings for DOS

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_dos",
  "task_type": "single_point",
  "params": {
    "software": "vasp",
    "ENCUT": 520,
    "ISMEAR": -5,
    "NEDOS": 3001,
    "LORBIT": 11,
    "system_name": "DOS calculation"
  }
}}
```

Key VASP parameters:
- `ISMEAR = -5`: tetrahedron method with Blochl corrections (accurate DOS)
- `NEDOS = 3001`: number of DOS grid points (default 301 is too coarse)
- `LORBIT = 11`: write projected DOS (DOSCAR with atom/orbital decomposition)

### Two-Step Pattern: Relax then DOS

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_dos",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "system_name": "relax"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_dos",
  "task_type": "single_point",
  "depends_on": "task_relax",
  "params": {
    "software": "vasp", "ENCUT": 520,
    "ISMEAR": -5, "NEDOS": 3001, "LORBIT": 11,
    "system_name": "DOS"
  }
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("DOS analysis - Pt(111)")

inp = wf.add_task("structure_input", structure=pt_slab_json)

# Step 1: Geometry optimization
opt = wf.add_task("geo_opt",
    structure=inp.output.structure,
    software="vasp", ENCUT=520)

# Step 2: DOS single-point on relaxed structure
dos_sp = wf.add_task("single_point",
    structure=opt.output.structure,
    software="vasp", ENCUT=520,
    ISMEAR=-5, NEDOS=3001, LORBIT=11)

# Step 3: Post-process DOS
dos = wf.add_task("dos_analysis",
    doscar=dos_sp.output.doscar,
    atom_indices=[0, 1, 2, 3],
    orbitals=["d"],
    compute_dband=True)

wf.submit()
```

## d-Band Center Theory

The d-band model (Hammer-Norskov) relates catalytic activity to the
d-band center position relative to the Fermi level:

```
epsilon_d = integral(E * rho_d(E) dE) / integral(rho_d(E) dE)
```

Integrated over occupied states (up to Fermi level).

| d-band center | Adsorbate binding | Catalytic implication |
|--------------|-------------------|---------------------|
| Higher (closer to E_F) | Stronger | More reactive, may over-bind |
| Lower (further from E_F) | Weaker | Less reactive, may under-bind |

### Surface vs Bulk d-Band

Surface atoms have narrower d-bands (fewer neighbors) and higher d-band
centers than bulk atoms. Always select surface atom indices for catalysis
analysis.

## Spin-Resolved DOS

For magnetic systems (Fe, Co, Ni, oxides), enable spin polarization:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_dos",
  "task_type": "single_point",
  "params": {
    "software": "vasp", "ENCUT": 520,
    "ISPIN": 2, "ISMEAR": -5, "NEDOS": 3001, "LORBIT": 11,
    "system_name": "spin-DOS"
  }
}}
```

Spin-resolved DOS returns separate up/down channels. The magnetic moment
per atom equals the integral of (rho_up - rho_down) up to E_F.

## Orbital Channels

Available orbital projections for PDOS:

| Channel | Orbitals | Use Case |
|---------|----------|----------|
| `"s"` | s | Main group elements |
| `"p"` | px, py, pz | O, N, C, S |
| `"d"` | dxy, dyz, dxz, dz2, dx2-y2 | Transition metals |
| `"f"` | 7 f-orbitals | Lanthanides, actinides |

Specific sub-orbitals: `"dz2"`, `"dx2-y2"`, `"dxy"`, `"dxz"`, `"dyz"`

## Common Pitfalls

1. Never use ISMEAR=1 (Methfessel-Paxton) for DOS -- it produces negative
   DOS artifacts. Use ISMEAR=-5 (tetrahedron) for static DOS calculations.
2. NEDOS=301 (VASP default) gives very coarse DOS. Use at least 2001-3001.
3. LORBIT=11 is required for PDOS. Without it, only total DOS is available.
4. Always do DOS as a separate single_point after geo_opt. The DOS from
   a relaxation run uses the smearing from NSW>0 and is unreliable.
5. For d-band center, select only surface layer atoms. Including bulk atoms
   averages out the surface electronic signature.
6. Band gap from DOS can be noisy -- compare with the band structure if
   precise gap values are needed.
