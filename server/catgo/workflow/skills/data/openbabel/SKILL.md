---
name: openbabel
description: >
  Convert molecular file formats using Open Babel. Handles SMILES, mol2, sdf, pdb,
  xyz, cif, and 100+ other formats. Also performs 3D coordinate generation and
  hydrogen addition.
compatibility: >
  Requires Open Babel installed (apt install openbabel or conda install openbabel).
  Python bindings optional (pip install openbabel-wheel).
catalog-hidden: true
---

# Open Babel — Molecular Format Conversion

## When to Use

- User needs to convert between molecular file formats (SMILES, mol2, sdf, pdb, xyz, cif)
- User wants to generate 3D coordinates from SMILES
- User needs to add/remove hydrogens
- User wants to perceive bond orders from a 3D structure
- User needs canonical SMILES or InChI identifiers

## Prerequisites

1. Open Babel installed (`obabel -V`)
2. For Python scripting: `openbabel` or `openbabel-wheel` package

## Workflow Steps — CLI

### Convert between formats

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "convert_format",
  "command": "obabel input.mol2 -O output.pdb",
  "system_name": "format_convert"
})
```

## Common CLI Commands

### SMILES to 3D structure

```bash
obabel -:"CCO" -O ethanol.xyz --gen3d
# Generates 3D coordinates using force field optimization
```

### Add hydrogens

```bash
obabel input.pdb -O output.pdb -h
# -h adds hydrogens at pH 7.4
```

### Remove hydrogens

```bash
obabel input.pdb -O output.pdb -d
```

### Batch conversion

```bash
obabel *.mol2 -O output_.pdb -m
# -m produces one output file per input molecule
```

### Generate conformers

```bash
obabel input.sdf -O conformers.sdf --conformer --nconf 50 --writeconformers
```

### Get canonical SMILES

```bash
obabel input.mol2 -O output.smi -ocan
```

### Energy minimization

```bash
obabel input.xyz -O minimized.xyz --minimize --ff MMFF94 --steps 2500
```

## Supported Formats (most common)

| Format | Extension | Notes |
|---|---|---|
| SMILES | .smi | 1D string representation |
| SDF/MOL | .sdf, .mol | 2D/3D with bond orders |
| PDB | .pdb | Protein Data Bank format |
| MOL2 | .mol2 | Tripos format with charges |
| XYZ | .xyz | Simple Cartesian coordinates |
| CIF | .cif | Crystallographic Information File |
| CML | .cml | Chemical Markup Language |
| InChI | - | IUPAC identifier (use `-oinchi`) |
| POSCAR | .vasp | VASP structure (limited support) |
| GJF/COM | .gjf, .com | Gaussian input |

## Python API

```python
from openbabel import openbabel as ob

conv = ob.OBConversion()
conv.SetInFormat("smi")
conv.SetOutFormat("mol2")

mol = ob.OBMol()
conv.ReadString(mol, "c1ccccc1")  # benzene

# Generate 3D
builder = ob.OBBuilder()
builder.Build(mol)

# Force field optimization
ff = ob.OBForceField.FindForceField("MMFF94")
ff.Setup(mol)
ff.ConjugateGradients(500)
ff.GetCoordinates(mol)

conv.WriteFile(mol, "benzene.mol2")
```

## Parameter Guidance

| Flag | Purpose |
|---|---|
| `--gen3d` | Generate 3D coordinates from 2D/SMILES |
| `-h` | Add hydrogens |
| `-d` | Delete hydrogens |
| `--minimize` | Energy minimization with force field |
| `--ff MMFF94` | Force field: MMFF94, UFF, Ghemical |
| `-m` | Multiple output files (one per molecule) |
| `--conformer` | Conformer search |
| `-ocan` | Output canonical SMILES |

## Common Pitfalls

1. **No 3D coordinates from SMILES** — SMILES are 1D strings. Use `--gen3d` to create 3D structures.
2. **Bond order loss** — XYZ format has no bond information. Converting xyz to mol2 requires bond perception (`-b` flag).
3. **Wrong protonation** — default `-h` adds H at pH 7.4. Specify pH with `-p <pH>` if needed.
4. **Large molecule conformers** — `--gen3d` gives one conformation. For proper conformer sampling, use RDKit (`molecular/rdkit/SKILL.md`).
5. **Periodic structures** — Open Babel's support for periodic systems (CIF/POSCAR) is limited. Use pymatgen or ASE for crystals.
6. **Force field coverage** — MMFF94 covers organic molecules well but may not have parameters for transition metals.
