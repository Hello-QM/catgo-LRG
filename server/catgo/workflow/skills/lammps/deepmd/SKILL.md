---
name: lammps-deepmd
description: >
  Run LAMMPS molecular dynamics with DeePMD-kit machine learning potentials.
  Use when the user wants MD simulations driven by a trained DP model.
compatibility: >
  Requires LAMMPS compiled with the DEEPMD package. A frozen DeePMD model (.pb) is required.
catalog-hidden: true
---

# LAMMPS + DeePMD Potential

## When to Use

- User wants to run MD with a trained DeePMD model
- User needs large-scale MD (10K-1M atoms) at near-DFT accuracy
- User wants to study diffusion, phase transitions, or surface reactions with ML potential
- User has a frozen `.pb` model file

## Prerequisites

1. LAMMPS compiled with DEEPMD package (`lmp -h | grep DEEPMD`)
2. Frozen DeePMD model file (`.pb`)
3. Initial structure (LAMMPS data file or from CatGo viewer)
4. Know the `type_map` used during model training

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "LAMMPS DeePMD NVT 300K"})
```

### 3. Add LAMMPS task

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "lmp_dpmd",
  "command": "lmp -in lammps.in > lammps.log 2>&1",
  "input_files": {
    "lammps.in": "<input script>",
    "frozen_model.pb": "{{model_path}}"
  },
  "system_name": "TiO2_md"
})
```

## LAMMPS Input Template — NVT

```
units           metal
boundary        p p p
atom_style      atomic

read_data       structure.lmp

pair_style      deepmd frozen_model.pb
pair_coeff      * *

neighbor        2.0 bin
neigh_modify    every 1 delay 0 check yes

# Velocities
velocity        all create 300.0 12345 dist gaussian

# NVT thermostat
fix             1 all nvt temp 300.0 300.0 0.1

# Timestep (ps in metal units)
timestep        0.001

# Output
thermo          100
thermo_style    custom step temp pe ke etotal press vol

dump            1 all custom 100 traj.lammpstrj id type x y z fx fy fz
dump_modify     1 sort id

# Restart
restart         10000 restart.*.data

run             100000
```

## LAMMPS Input Template — NPT

Replace the fix line:

```
fix             1 all npt temp 300.0 300.0 0.1 iso 0.0 0.0 1.0
```

## Model Deviation (Multi-Model)

For active learning or reliability checking, use multiple models:

```
pair_style      deepmd model_0.pb model_1.pb model_2.pb model_3.pb out_freq 100 out_file model_devi.out
pair_coeff      * *
```

This writes `model_devi.out` with per-frame max/min/avg force deviation. Use thresholds:
- `max_devi_f < 0.05` eV/Ang: model is reliable
- `0.05 < max_devi_f < 0.15`: candidate for active learning
- `max_devi_f > 0.15`: model is unreliable, do not trust results

## Preparing LAMMPS Data File

Convert from CatGo structure to LAMMPS data format:

```python
from ase.io import read, write
# Read pymatgen dict, write LAMMPS data
atoms = read('structure.json')
write('structure.lmp', atoms, format='lammps-data')
```

Or use dpdata (see `data/dpdata/SKILL.md`).

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| timestep | 0.001 ps (1 fs) | Metal units; can use 2 fs for stiff systems |
| NVT temp damp | 0.1 ps | Nose-Hoover damping; 100x timestep |
| NPT press damp | 1.0 ps | Pressure damping; 1000x timestep |
| dump frequency | 100-1000 | Every 100 steps = 0.1 ps |
| neighbor skin | 2.0 Ang | Rebuild neighbor list threshold |
| run | 100K-10M | Depends on property of interest |

## Common Pitfalls

1. **Wrong units** — DeePMD pair_style requires `units metal` (eV, Ang, ps). Never use `units real`.
2. **type_map mismatch** — atom types in LAMMPS data file must match the order in the DP model's type_map.
3. **Unfrozen model** — `pair_style deepmd` needs a frozen `.pb` file. Run `dp freeze` first.
4. **Too large timestep** — 1 fs is safe; 2 fs may cause energy drift for light elements (H).
5. **No equilibration** — always equilibrate for 10-50 ps before production run. Discard equilibration data.
6. **Memory for large models** — GPU memory limits apply. For 1M+ atoms, use CPU or multi-GPU.
