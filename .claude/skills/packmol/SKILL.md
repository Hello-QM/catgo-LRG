---
name: packmol
description: >
  Generate initial configurations for molecular simulations using Packmol.
  Build liquid boxes, mixtures, solutions, and solvated systems by packing
  molecules into a defined region.
compatibility: >
  Requires Packmol installed (apt install packmol or compiled from source).
  Input molecules must be in PDB or XYZ format.
catalog-hidden: true
---

# Packmol — Mixture/Solution Box Generation

## When to Use

- User needs to build a liquid simulation box (water, organic solvents)
- User wants to create a mixture of different molecules
- User needs to solvate a solute in a solvent box
- User is preparing initial structures for LAMMPS ReaxFF or classical MD
- User needs to fill a region with molecules at a target density

## Prerequisites

1. Packmol installed (`packmol < /dev/null` should print version)
2. Molecule coordinate files in PDB or XYZ format
3. For molecules from SMILES: first convert with Open Babel (`data/openbabel/SKILL.md`)

## Workflow Steps

### 1. Prepare molecule files

If starting from SMILES, convert to PDB first:
```bash
obabel -:"O" -O water.pdb --gen3d -h
obabel -:"CCO" -O ethanol.pdb --gen3d -h
```

### 2. Create Packmol input and run

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "packmol_mix",
  "command": "packmol < mixture.inp > packmol.log 2>&1",
  "input_files": {
    "mixture.inp": "<packmol input>",
    "water.pdb": "<water coords>",
    "ethanol.pdb": "<ethanol coords>"
  },
  "system_name": "water_ethanol_mix"
})
```

## Packmol Input Template — Simple Liquid Box

```
tolerance 2.0
filetype pdb
output mixture.pdb

structure water.pdb
  number 1000
  inside box 0.0 0.0 0.0 30.0 30.0 30.0
end structure
```

## Packmol Input Template — Binary Mixture

```
tolerance 2.0
filetype pdb
output mixture.pdb

# Water (70% by count)
structure water.pdb
  number 700
  inside box 0.0 0.0 0.0 40.0 40.0 40.0
end structure

# Ethanol (30% by count)
structure ethanol.pdb
  number 300
  inside box 0.0 0.0 0.0 40.0 40.0 40.0
end structure
```

## Packmol Input Template — Solvated Solute

```
tolerance 2.0
filetype pdb
output solvated.pdb

# Solute (fixed at center)
structure solute.pdb
  number 1
  center
  fixed 20.0 20.0 20.0 0.0 0.0 0.0
end structure

# Solvent around solute
structure water.pdb
  number 500
  inside box 0.0 0.0 0.0 40.0 40.0 40.0
  outside sphere 20.0 20.0 20.0 5.0
end structure
```

## Packmol Input Template — Layered System (e.g., Interface)

```
tolerance 2.0
filetype pdb
output interface.pdb

# Liquid phase
structure hexane.pdb
  number 200
  inside box 0.0 0.0 0.0 30.0 30.0 15.0
end structure

# Gas phase
structure oxygen.pdb
  number 50
  inside box 0.0 0.0 15.0 30.0 30.0 30.0
end structure
```

## Box Size Estimation

Target density determines box size. For water at 1 g/cm3:

```
N_molecules * M_molecule / (N_A * V_box) = density

For 1000 water molecules:
V = 1000 * 18.015 / (6.022e23 * 1.0) = 2.993e-20 cm3
L = V^(1/3) = 3.1e-7 cm = 31.0 Angstrom
```

Use a box slightly larger (e.g., 32 Ang) and equilibrate with NPT MD.

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| tolerance | 2.0 Ang | Minimum distance between atoms of different molecules |
| filetype | pdb or xyz | Must match input molecule files |
| number | varies | Number of molecules of each type |
| inside box | x0 y0 z0 x1 y1 z1 | Rectangular region (Angstrom) |
| inside sphere | cx cy cz r | Spherical region |
| outside sphere | cx cy cz r | Exclusion zone (for solvation) |
| fixed | x y z a b c | Fix position and orientation (angles in degrees) |

## Common Pitfalls

1. **Tolerance too small** — `tolerance 2.0` works for most cases. Smaller values cause Packmol to fail to converge.
2. **Box too small** — if density is too high, Packmol cannot place all molecules. Increase box size.
3. **Wrong filetype** — `filetype pdb` must match the actual input file format.
4. **No equilibration after Packmol** — Packmol output is NOT equilibrated. Always run NPT MD to relax the density.
5. **Missing hydrogens** — ensure input molecules have correct hydrogens before packing.
6. **Molecule overlap with solute** — use `outside sphere` to prevent solvent from overlapping with a fixed solute.
7. **Convergence failure** — if Packmol does not converge, increase `tolerance` or box size, or reduce molecule count.
