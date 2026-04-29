---
name: phonopy
description: >
  Run phonon calculations using Phonopy. Computes phonon band structures,
  density of states, thermal properties, and checks dynamical stability.
  Works with VASP, QE, ABINIT, and other DFT codes as the force calculator.
compatibility: >
  Requires phonopy Python package (pip install phonopy). Requires a DFT code
  (VASP, QE, etc.) for force calculations on displaced structures.
catalog-hidden: true
---

# Phonopy — Phonon Calculations

## When to Use

- User needs phonon band structure or phonon DOS
- User wants to check dynamical stability (imaginary phonon modes)
- User needs thermodynamic properties (heat capacity, entropy, free energy) from phonons
- User wants to compute thermal expansion or Gruneisen parameters
- User has a relaxed structure and wants vibrational properties beyond the Gamma point

## Prerequisites

1. phonopy installed (`phonopy --version`)
2. A DFT code (VASP, QE, ABINIT) for computing forces on displaced structures
3. A fully relaxed structure (forces < 0.001 eV/Ang on all atoms)
4. Tight SCF convergence in force calculations (EDIFF=1e-8 for VASP)

## Workflow Overview

Phonopy uses the finite-displacement method:

1. Generate supercells with displaced atoms
2. Run DFT force calculations on each displaced supercell
3. Collect forces and compute force constants
4. Post-process: band structure, DOS, thermal properties

## Workflow Steps

### 1. Create supercells with displacements

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "phonopy_displace",
  "command": "phonopy -d --dim 2 2 2 -c POSCAR",
  "input_files": {
    "POSCAR": "<relaxed structure>"
  },
  "system_name": "phonon_setup"
})
```

This generates `POSCAR-001`, `POSCAR-002`, ..., `phonopy_disp.yaml`.

### 2. Run DFT on each displaced structure

For each displaced POSCAR, run a VASP single-point calculation:

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "phonon_forces_001",
  "command": "cd disp-001 && vasp_std > vasp.out 2>&1",
  "depends_on": ["phonopy_displace"],
  "system_name": "phonon_disp_001"
})
```

VASP INCAR for force calculations:

```
PREC    = Accurate
ENCUT   = 520
EDIFF   = 1e-8      # Must be tight for phonons
IBRION  = -1
NSW     = 0
ISMEAR  = 0
SIGMA   = 0.05
LREAL   = .FALSE.    # Must be FALSE for phonons
LWAVE   = .FALSE.
LCHARG  = .FALSE.
```

### 3. Collect forces and compute force constants

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "phonopy_forces",
  "command": "phonopy -f disp-001/vasprun.xml disp-002/vasprun.xml ...",
  "depends_on": ["phonon_forces_001", "phonon_forces_002"],
  "system_name": "phonon_fc"
})
```

### 4. Compute phonon band structure

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "phonopy_band",
  "command": "phonopy -p band.conf",
  "input_files": {
    "band.conf": "DIM = 2 2 2\nBAND = AUTO\nBAND_POINTS = 101\nBAND_LABELS = AUTO"
  },
  "depends_on": ["phonopy_forces"],
  "system_name": "phonon_band"
})
```

## Configuration Files

### band.conf — Band structure

```
DIM = 2 2 2
BAND = AUTO
BAND_POINTS = 101
```

### mesh.conf — DOS and thermal properties

```
DIM = 2 2 2
MP = 20 20 20
TPROP = .TRUE.
TMIN = 0
TMAX = 1000
TSTEP = 10
```

### pdos.conf — Projected DOS

```
DIM = 2 2 2
MP = 20 20 20
PDOS = 1 2, 3 4 5 6
```

Atom indices are 1-based. Groups separated by commas.

## Python API

```python
import phonopy
from phonopy import Phonopy

ph = phonopy.load("phonopy_disp.yaml")
# Forces already set via phonopy -f

# Band structure
ph.auto_band_structure(plot=True)
ph.save("phonopy_results.yaml")

# Thermal properties
ph.run_mesh([20, 20, 20])
ph.run_thermal_properties(t_min=0, t_max=1000, t_step=10)
tp = ph.get_thermal_properties_dict()
# tp['temperatures'], tp['free_energy'], tp['entropy'], tp['heat_capacity']
```

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| DIM | 2 2 2 or 3 3 3 | Supercell size; larger = more accurate but more DFT calcs |
| MP | 20 20 20 | q-point mesh for DOS; denser = smoother DOS |
| BAND | AUTO | Auto high-symmetry path; or specify manually |
| displacement | 0.01 Ang | Default; increase for very stiff materials |
| TPROP | .TRUE. | Enable thermal property calculation |

## Interpreting Results

- **No imaginary modes** — structure is dynamically stable
- **Imaginary modes at Gamma** — structure is unstable; re-optimize or try different cell
- **Imaginary modes at zone boundary** — possible CDW or structural phase transition
- **Flat acoustic modes** — check supercell size; may need larger DIM

## Common Pitfalls

1. **Structure not fully relaxed** — residual forces cause spurious imaginary modes. Relax to < 0.001 eV/Ang.
2. **LREAL=Auto in VASP** — must use `LREAL = .FALSE.` for phonon force calculations. Real-space projection introduces noise.
3. **Supercell too small** — DIM = 1 1 1 gives only Gamma phonons. Use at least 2 2 2 for bulk.
4. **SCF not converged** — use EDIFF=1e-8 (not 1e-5). Loose SCF causes noisy force constants.
5. **Symmetry mismatch** — phonopy uses symmetry to reduce displacements. Ensure the input structure has correct symmetry.
6. **Many displacements** — low-symmetry structures can generate 100+ displaced supercells. Budget DFT time accordingly.
7. **Acoustic sum rule** — slight violations are normal. Phonopy applies corrections automatically.
