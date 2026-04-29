---
name: lammps-reaxff
description: >
  Run LAMMPS molecular dynamics with ReaxFF reactive force field. Use when the user
  needs reactive MD for combustion, oxidation, corrosion, or bond breaking/forming.
compatibility: >
  Requires LAMMPS compiled with the REAXFF package. A ReaxFF parameter file
  (ffield.reax) is required for the element combination.
catalog-hidden: true
---

# LAMMPS + ReaxFF

## When to Use

- User needs reactive molecular dynamics (bonds can break and form)
- User wants to study combustion, pyrolysis, oxidation, or corrosion
- User needs to model chemical reactions at the atomic scale without QM
- User has a ReaxFF parameter file for the relevant elements

## Prerequisites

1. LAMMPS compiled with REAXFF package (`lmp -h | grep REAXFF`)
2. ReaxFF parameter file (`ffield.reax.xxx`) for the element combination
3. Initial structure — can be built with Packmol (see `data/packmol/SKILL.md`)

## Workflow Steps

### 1. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "ReaxFF combustion - methane/O2"})
```

### 2. Add ReaxFF MD task

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "reaxff_md",
  "command": "lmp -in lammps.in > lammps.log 2>&1",
  "input_files": {
    "lammps.in": "<input script>",
    "ffield.reax.CHO": "<reaxff params>"
  },
  "system_name": "CH4_combustion"
})
```

### 3. Analyze with ReacNetGenerator (optional)

After MD completes, use `analysis/reacnetgen/SKILL.md` to extract reaction networks.

## LAMMPS Input Template — ReaxFF NVT

```
units           real
boundary        p p p
atom_style      charge

read_data       structure.lmp

pair_style      reaxff NULL
pair_coeff      * * ffield.reax.CHO C H O

neighbor        2.0 bin
neigh_modify    every 10 delay 0 check yes

# Charge equilibration
fix             qeq all qeq/reaxff 1 0.0 10.0 1.0e-6 reaxff

# Velocities
velocity        all create 2000.0 12345 dist gaussian

# NVT
fix             1 all nvt temp 2000.0 2000.0 100.0

# Timestep (fs in real units)
timestep        0.25

# Output
thermo          100
thermo_style    custom step temp pe ke etotal press vol density

dump            1 all custom 100 traj.lammpstrj id type q x y z
dump_modify     1 sort id element C H O

# Bond order output (for reaction analysis)
fix             bonds all reaxff/bonds 1000 bonds.reax

run             500000
```

## Important ReaxFF-Specific Settings

### Charge Equilibration (MANDATORY)

ReaxFF requires dynamic charge equilibration at every step:
```
fix  qeq all qeq/reaxff 1 0.0 10.0 1.0e-6 reaxff
```
**Never omit this fix.** Without it, charges are not updated and results are physically meaningless.

### Small Timestep

ReaxFF requires small timesteps due to reactive dynamics:
- **0.25 fs** — safe for most systems (recommended)
- **0.5 fs** — acceptable for heavy-atom systems without H
- **1.0 fs** — only for non-reactive equilibration phases

### Bond Order Output

For reaction analysis, write bond information:
```
fix  bonds all reaxff/bonds 1000 bonds.reax
```

Feed `bonds.reax` to ReacNetGenerator for automated reaction network extraction.

## Parameter File Sources

| File | Elements | Reference |
|---|---|---|
| ffield.reax.CHO | C, H, O | Chenoweth et al. (2008) — combustion |
| ffield.reax.Fe_O_C_H | Fe, O, C, H | Aryanpour et al. (2010) — iron oxidation |
| ffield.reax.AB | A, B (various) | Check doi.org/10.1021/acs.jctc.* for specific systems |

Always cite the original ReaxFF parameterization paper.

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| timestep | 0.25 fs | Real units (fs); must be small for reactive dynamics |
| NVT temp damp | 100 fs | 100-200 fs typical in real units |
| qeq tolerance | 1.0e-6 | Charge equilibration convergence |
| Temperature | 1500-3000 K | Reactive events need high T to overcome barriers |
| Run length | 500K-5M steps | 125 ps - 1.25 ns at 0.25 fs timestep |
| Dump freq | 100-500 | For trajectory and reaction analysis |

## Common Pitfalls

1. **Missing qeq/reaxff fix** — charges are not static in ReaxFF. Omitting charge equilibration gives garbage results.
2. **Wrong units** — ReaxFF uses `units real` (kcal/mol, Ang, fs). Never use `units metal`.
3. **Timestep too large** — 0.25 fs is the safe maximum. Larger timesteps cause energy conservation failure.
4. **Wrong element order** — `pair_coeff * * ffield.reax.CHO C H O` must match atom types in data file.
5. **Parameter file incompatibility** — ReaxFF parameters are NOT transferable between element combinations. Use only validated parameter sets.
6. **System too small** — ReaxFF MD of reactions needs at least 500-1000 atoms for meaningful statistics.
7. **Temperature too low** — reactions have barriers. Below 1000 K, you may see no reactive events in affordable simulation time.
