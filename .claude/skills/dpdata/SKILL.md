---
name: dpdata
description: >
  Convert between computational chemistry data formats using dpdata. Handles
  VASP, QE, CP2K, Gaussian, LAMMPS, and DeePMD formats. Essential for preparing
  ML potential training data.
compatibility: >
  Requires dpdata Python package (pip install dpdata). Works on any platform.
catalog-hidden: true
---

# dpdata — Format Conversion

## When to Use

- User needs to convert DFT calculation outputs to DeePMD training format
- User wants to convert between VASP, QE, CP2K, Gaussian, LAMMPS formats
- User needs to merge, filter, or split trajectory data
- User is preparing training data for machine learning potentials

## Prerequisites

1. dpdata installed (`pip install dpdata`, or `python -c "import dpdata"`)

## Supported Formats

| Format | Read | Write | Key |
|---|---|---|---|
| VASP OUTCAR | Yes | - | `vasp/outcar` |
| VASP POSCAR/CONTCAR | Yes | Yes | `vasp/poscar` |
| VASP XML | Yes | - | `vasp/xml` |
| QE pw.x output | Yes | - | `qe/pw/scf` |
| CP2K output | Yes | - | `cp2k/output` |
| Gaussian log | Yes | - | `gaussian/log` |
| LAMMPS dump | Yes | Yes | `lammps/dump` |
| LAMMPS data | Yes | Yes | `lammps/lmp` |
| DeePMD raw | Yes | Yes | `deepmd/raw` |
| DeePMD npy | Yes | Yes | `deepmd/npy` |
| ExtXYZ | Yes | Yes | `extxyz` |

## Workflow Steps

### 1. Convert VASP OUTCAR to DeePMD

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "convert_data",
  "command": "python convert.py",
  "input_files": {
    "convert.py": "import dpdata\nd = dpdata.LabeledSystem('OUTCAR', fmt='vasp/outcar')\nd.to('deepmd/npy', 'training_data')"
  },
  "system_name": "data_prep"
})
```

## Common Conversion Scripts

### VASP to DeePMD (with train/valid split)

```python
import dpdata
import numpy as np

# Load all frames from OUTCAR
d = dpdata.LabeledSystem("OUTCAR", fmt="vasp/outcar")
print(f"Loaded {len(d)} frames")

# Random split: 90% train, 10% valid
indices = np.random.permutation(len(d))
n_train = int(0.9 * len(d))

d_train = d.sub_system(indices[:n_train])
d_valid = d.sub_system(indices[n_train:])

d_train.to("deepmd/npy", "data/train")
d_valid.to("deepmd/npy", "data/valid")
print(f"Train: {len(d_train)}, Valid: {len(d_valid)}")
```

### Multiple OUTCARs to single dataset

```python
import dpdata
from pathlib import Path

d = None
for outcar in Path(".").rglob("OUTCAR"):
    sys = dpdata.LabeledSystem(str(outcar), fmt="vasp/outcar")
    d = sys if d is None else d + sys

print(f"Total frames: {len(d)}")
d.to("deepmd/npy", "merged_data")
```

### QE to DeePMD

```python
import dpdata
d = dpdata.LabeledSystem("relax.out", fmt="qe/pw/scf")
d.to("deepmd/npy", "training_data")
```

### LAMMPS dump to ExtXYZ

```python
import dpdata
d = dpdata.System("dump.lammpstrj", fmt="lammps/dump",
                  type_map=["Ti", "O"])
d.to("extxyz", "trajectory.xyz")
```

### Filter by energy/force

```python
import dpdata
import numpy as np

d = dpdata.LabeledSystem("OUTCAR", fmt="vasp/outcar")

# Remove frames with max force > 10 eV/Ang (likely unconverged)
mask = []
for i in range(len(d)):
    max_f = np.max(np.abs(d["forces"][i]))
    mask.append(max_f < 10.0)

d_clean = d.sub_system(np.where(mask)[0])
print(f"Kept {len(d_clean)}/{len(d)} frames")
```

## CLI Usage

```bash
# Quick convert
dpdata convert OUTCAR vasp/outcar deepmd/npy training_data

# System info
dpdata info OUTCAR vasp/outcar
```

## Parameter Guidance

| Parameter | Notes |
|---|---|
| `fmt` | Format string — must match exactly (case-sensitive) |
| `type_map` | Required for LAMMPS formats — maps type indices to element symbols |
| `begin` / `end` / `step` | Frame selection for large trajectories |

## Common Pitfalls

1. **Missing type_map for LAMMPS** — LAMMPS dump files have numeric types, not element names. Always provide `type_map`.
2. **Unconverged frames** — VASP OUTCARs may contain unconverged ionic steps. Filter by force magnitude before training.
3. **Mixed element order** — when merging data from different calculations, ensure consistent element ordering.
4. **Large memory for big trajectories** — dpdata loads all frames into memory. For >10K frames, process in chunks.
5. **Units** — dpdata converts to eV/Angstrom internally. LAMMPS `real` units are auto-converted.
