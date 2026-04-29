---
name: reacnetgenerator
description: >
  Extract and visualize reaction networks from reactive MD trajectories using
  ReacNetGenerator. Use after ReaxFF or ab initio MD simulations to identify
  reaction pathways, species, and kinetics.
compatibility: >
  Requires ReacNetGenerator Python package (pip install reacnetgenerator).
  Input trajectories must be in LAMMPS dump or XYZ format with bond information.
catalog-hidden: true
---

# ReacNetGenerator — Reaction Network Analysis

## When to Use

- User has completed a reactive MD simulation (ReaxFF or AIMD) and wants to extract reactions
- User wants to identify all chemical species formed during a simulation
- User needs a reaction network diagram showing pathways and frequencies
- User wants to track species concentrations over time
- User is studying combustion, pyrolysis, or other reactive processes

## Prerequisites

1. ReacNetGenerator installed (`reacnetgenerator --version` or `python -c "import reacnetgenerator"`)
2. MD trajectory file (LAMMPS dump with bond info, or XYZ with bond detection)
3. Bond order file from ReaxFF (`bonds.reax` from `fix reaxff/bonds`)

## Workflow Steps

### 1. Run after ReaxFF MD

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "reacnet_analyze",
  "command": "reacnetgenerator -i traj.lammpstrj --type lammpsbondfile -b bonds.reax -a C H O",
  "depends_on": ["reaxff_md"],
  "system_name": "reaction_network"
})
```

## CLI Usage

### From LAMMPS dump + bond file

```bash
reacnetgenerator \
  -i traj.lammpstrj \
  --type lammpsbondfile \
  -b bonds.reax \
  -a C H O \
  --stepinterval 10 \
  --split 200
```

### From XYZ trajectory (bond detection by distance)

```bash
reacnetgenerator \
  -i trajectory.xyz \
  --type xyz \
  -a C H O \
  --stepinterval 10
```

## Python API

```python
from reacnetgenerator import ReacNetGenerator

rng = ReacNetGenerator(
    inputfilename="traj.lammpstrj",
    inputfiletype="lammpsbondfile",
    bondfilename="bonds.reax",
    atomname=["C", "H", "O"],
    stepinterval=10,
    split=200,
)

rng.runanddraw()
# Outputs: reaction network SVG/HTML, species list, reaction matrix
```

## Output Files

| File | Content |
|---|---|
| `*.svg` / `*.html` | Reaction network visualization |
| `species.csv` | All detected species with SMILES and counts |
| `reactionmatrix.csv` | Reaction frequency matrix |
| `*.png` | Species concentration over time plots |

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| `-i` | trajectory file | LAMMPS dump or XYZ |
| `--type` | lammpsbondfile / xyz | Input type |
| `-b` | bonds.reax | Bond order file (ReaxFF only) |
| `-a` | C H O | Element names in order of LAMMPS type |
| `--stepinterval` | 10-100 | Analyze every Nth frame (speeds up) |
| `--split` | 100-500 | Split trajectory into N chunks for statistics |
| `--cutoff` | 0.3 | Bond order cutoff (default 0.3 for ReaxFF) |
| `--nproc` | 4 | Parallel workers |

## Interpreting Results

### Reaction Network Graph

- **Nodes** = chemical species (labeled with molecular formula or SMILES)
- **Edges** = reactions (thickness proportional to frequency)
- **Hub species** = key intermediates (many connections)
- **Isolated nodes** = stable products or rare species

### Species Time Evolution

- Monotonically decreasing = reactant being consumed
- Monotonically increasing = product being formed
- Rise then fall = intermediate species
- Oscillating = reversible reaction or equilibrium

## Integration with CatGo Workflow

Typical reactive MD analysis pipeline:

```
1. Build mixture box        → data/packmol/SKILL.md
2. Run ReaxFF MD            → lammps/reaxff/SKILL.md
3. Extract reaction network → analysis/reacnetgen/SKILL.md (this skill)
```

## Common Pitfalls

1. **Wrong atom order** — `-a C H O` must match LAMMPS atom type indices (1=C, 2=H, 3=O). Check the data file.
2. **Bond file not generated** — ensure `fix reaxff/bonds` was included in the LAMMPS input. Without it, no bond information exists.
3. **Too few frames** — need at least 1000+ frames for statistically meaningful reaction counts.
4. **stepinterval too large** — skipping too many frames misses short-lived intermediates. Start with 10.
5. **Cutoff too high/low** — bond order cutoff of 0.3 works for most ReaxFF simulations. Adjust if species look wrong.
6. **Memory for large trajectories** — very long MD trajectories can exhaust memory. Use `--stepinterval` to reduce.
7. **No reactions observed** — temperature may be too low, or simulation too short. Check the ReaxFF MD conditions.
