---
name: deepmd-router
description: >
  Route DeePMD-kit requests to training or inference sub-skills. Use when the user
  requests machine learning potentials, DeePMD, DPA-3, DP models, or MLIP training.
compatibility: >
  Requires deepmd-kit installed (pip install deepmd-kit). GPU recommended for training.
---

# DeePMD Router

Route DeePMD-kit requests to the appropriate sub-skill.

## Routing Table

| User intent | Route to |
|---|---|
| Train a new DP model (DPA-3, se_e2_a, fine-tune) | `train/SKILL.md` |
| Run inference, predict energy/forces, evaluate model | `inference/SKILL.md` |
| Run MD with a DP model | `../lammps/deepmd/SKILL.md` |

## Shared Policies

1. **Data format** — DeePMD training data must be in dpdata format. If user has VASP/QE output, route through `../data/dpdata/SKILL.md` first.
2. **Model selection** — DPA-3 is the recommended architecture for new projects. Use se_e2_a only for legacy compatibility.
3. **GPU requirement** — training requires GPU. Inference can run on CPU but is much faster on GPU.
4. **Validation split** — always hold out 10-20% of data for validation. Never train on all data.

## Quick Decision Guide

- "Train a potential" / "fit a model" / "DPA-3" → `train/SKILL.md`
- "Fine-tune" / "transfer learn" → `train/SKILL.md` (fine-tune section)
- "Predict" / "evaluate" / "test model" → `inference/SKILL.md`
- "Run MD with DP" / "LAMMPS + DeePMD" → `../lammps/deepmd/SKILL.md`
- "Convert data" / "prepare training data" → `../data/dpdata/SKILL.md`
