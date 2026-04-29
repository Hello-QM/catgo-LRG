---
name: deepmd-train
description: >
  Train DeePMD-kit machine learning potentials. Covers DPA-3 (recommended),
  se_e2_a (legacy), and fine-tuning from pretrained models.
compatibility: >
  Requires deepmd-kit >= 3.0, GPU with CUDA. Training data in dpdata format.
catalog-hidden: true
---

# DeePMD Training

## When to Use

- User wants to train a machine learning interatomic potential
- User has DFT data (energies, forces, stresses) and wants a DP model
- User wants to fine-tune a pretrained DPA-3 model

## Prerequisites

1. Training data in DeePMD format (use `data/dpdata/SKILL.md` to convert from VASP/QE)
2. GPU node available on HPC
3. deepmd-kit installed (`dp --version`)

## Data Directory Structure

```
data/
├── train/
│   ├── set.000/
│   │   ├── coord.npy       # Atomic coordinates (natoms*3,)
│   │   ├── energy.npy      # Total energy (1,)
│   │   ├── force.npy       # Forces (natoms*3,)
│   │   ├── box.npy         # Cell vectors (9,)
│   │   └── virial.npy      # Stress tensor (optional, 9,)
│   └── type.raw            # Atom type indices
└── valid/
    └── set.000/
        └── ...
```

## Workflow Steps

### 1. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "DeePMD DPA-3 training"})
```

### 2. Add training task

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "dp_train",
  "command": "dp train input.json 2>&1 | tee train.log",
  "input_files": {
    "input.json": "<training config>"
  },
  "system_name": "dp_model"
})
```

### 3. Add freeze step (convert to production model)

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "dp_freeze",
  "command": "dp freeze -o frozen_model.pb",
  "depends_on": ["dp_train"],
  "system_name": "dp_model"
})
```

## DPA-3 Training Config (Recommended)

```json
{
  "model": {
    "type_map": ["Ti", "O"],
    "descriptor": {
      "type": "dpa3",
      "rcut": 6.0,
      "rcut_smth": 0.5,
      "sel": "auto",
      "neuron": [25, 50, 100],
      "n_interaction": 3,
      "n_head": 4
    },
    "fitting_net": {
      "type": "ener",
      "neuron": [240, 240, 240]
    }
  },
  "training": {
    "training_data": {
      "systems": ["./data/train"],
      "batch_size": "auto"
    },
    "validation_data": {
      "systems": ["./data/valid"],
      "batch_size": "auto"
    },
    "numb_steps": 1000000,
    "disp_freq": 1000,
    "save_freq": 10000
  },
  "learning_rate": {
    "type": "exp",
    "start_lr": 1e-3,
    "stop_lr": 1e-8,
    "decay_steps": 5000
  },
  "loss": {
    "type": "ener",
    "start_pref_e": 0.02,
    "limit_pref_e": 1.0,
    "start_pref_f": 1000,
    "limit_pref_f": 1.0,
    "start_pref_v": 0.0,
    "limit_pref_v": 0.0
  }
}
```

## se_e2_a Training Config (Legacy)

Replace the descriptor block:

```json
"descriptor": {
  "type": "se_e2_a",
  "rcut": 6.0,
  "rcut_smth": 0.5,
  "sel": [46, 92],
  "neuron": [25, 50, 100],
  "axis_neuron": 16
}
```

`sel` must list the max neighbor count per element type. Use `dp neighbor-stat` to determine.

## Fine-Tuning from Pretrained Model

```bash
# Download pretrained model (e.g., from AIS Square)
# Then fine-tune:
dp train input.json --finetune pretrained.pb 2>&1 | tee finetune.log
```

Reduce `numb_steps` to 100000-200000 and `start_lr` to 1e-4 for fine-tuning.

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| rcut | 6.0-9.0 A | Interaction cutoff; larger = more accurate but slower |
| sel | auto or [N1, N2] | Max neighbors per type; use `dp neighbor-stat` |
| numb_steps | 500K-2M | More data needs more steps |
| start_lr | 1e-3 | Learning rate; reduce for fine-tuning |
| batch_size | auto | Let DeePMD choose based on system size |
| start_pref_f | 1000 | Force weight starts high, decays to limit_pref_f |

## Common Pitfalls

1. **Insufficient training data** — need at least 1000-5000 frames for a reliable model. More diverse configs = better.
2. **sel too small** — if max neighbors exceeds `sel`, training crashes. Always run `dp neighbor-stat` first.
3. **Overfitting** — monitor validation loss. If train loss drops but valid loss plateaus, stop training or add more data.
4. **Missing virial** — if training data has no stress tensor, set `start_pref_v = 0, limit_pref_v = 0`.
5. **Mixed element sets** — `type_map` must be consistent across all training systems and inference.
6. **Forgetting to freeze** — the checkpoint directory is not the production model. Run `dp freeze` to create a portable `.pb` file.
