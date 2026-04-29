---
name: deepmd-inference
description: >
  Run DeePMD-kit inference to predict energies, forces, and stresses using a
  trained DP model. Also covers model evaluation and testing.
compatibility: >
  Requires deepmd-kit installed. A frozen model (.pb) file is needed.
catalog-hidden: true
---

# DeePMD Inference

## When to Use

- User wants to predict energy/forces for a structure using a trained DP model
- User wants to evaluate model accuracy against DFT reference data
- User wants to use a DP model as an ASE calculator for optimization or NEB

## Prerequisites

1. A frozen DeePMD model file (`.pb` or `.savedmodel`)
2. deepmd-kit installed (`dp --version`)
3. Structure to predict on, or test data in dpdata format

## Workflow Steps

### 1. Model Testing (against reference data)

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "dp_test",
  "command": "dp test -m frozen_model.pb -s ./data/test -n 100 -d test_results 2>&1 | tee test.log",
  "system_name": "dp_eval"
})
```

This outputs RMSE for energy, forces, and virial.

### 2. Single Structure Prediction (Python)

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "dp_predict",
  "command": "python predict.py",
  "input_files": {
    "predict.py": "<script content>"
  },
  "system_name": "dp_predict"
})
```

## Python Script — Single Prediction

```python
from deepmd.infer import DeepPot
from ase.io import read
import numpy as np

dp = DeepPot("frozen_model.pb")
atoms = read("structure.vasp")

coord = atoms.get_positions().reshape(1, -1)
cell = atoms.get_cell().array.reshape(1, -1)
atype = [dp.get_type_map().index(s) for s in atoms.get_chemical_symbols()]

energy, force, virial = dp.eval(coord, cell, atype)

print(f"Energy: {energy[0][0]:.6f} eV")
print(f"Max force: {np.max(np.abs(force)):.6f} eV/Ang")
```

## Python Script — ASE Calculator

```python
from deepmd.calculator import DP
from ase.io import read, write
from ase.optimize import BFGS

atoms = read("structure.vasp")
atoms.calc = DP(model="frozen_model.pb")

# Single point
energy = atoms.get_potential_energy()
forces = atoms.get_forces()
print(f"Energy: {energy:.6f} eV")

# Optimization
opt = BFGS(atoms, trajectory="opt.traj")
opt.run(fmax=0.01)
write("optimized.vasp", atoms)
```

## dp test Output Format

```
Energy RMSE        : 1.234e-03 eV/atom
Force  RMSE        : 2.345e-02 eV/Ang
Virial RMSE        : 3.456e-01 eV/cell
```

Acceptable thresholds:
- Energy: < 5 meV/atom
- Force: < 100 meV/Ang (< 50 meV/Ang for high accuracy)
- Virial: < 1 kbar

## Model Compression (for faster inference)

```bash
dp compress -i frozen_model.pb -o compressed_model.pb
```

Compressed models are 3-10x faster with minimal accuracy loss. Always compress before production MD.

## Parameter Guidance

| Parameter | Notes |
|---|---|
| `-m` | Path to frozen model (.pb) |
| `-s` | Path to test data directory (dpdata format) |
| `-n` | Number of test frames (default: all) |
| `-d` | Output directory for detailed results |
| `--atomic` | Output per-atom energy decomposition |

## Common Pitfalls

1. **type_map mismatch** — the element order in inference must match training. Check with `dp show-type-map frozen_model.pb`.
2. **Unfrozen model** — `dp test` and ASE calculator need a frozen `.pb` file, not the training checkpoint directory.
3. **Extrapolation** — DP models are unreliable outside the training data distribution. Check the model deviation.
4. **Model deviation** — for production use, train 4 models with different seeds and compute `max_devi_f` to detect extrapolation.
5. **Memory for large systems** — DP inference on 10K+ atoms can exceed GPU memory. Use `--batch-size` or CPU inference.
