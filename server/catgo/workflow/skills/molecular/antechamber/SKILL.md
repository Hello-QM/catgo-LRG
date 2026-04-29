---
name: antechamber
description: >
  Use AmberTools antechamber for molecular force field parameterization.
  Generates GAFF/GAFF2 parameters and AM1-BCC or RESP charges for use in
  AMBER or LAMMPS classical MD simulations.
compatibility: >
  Requires AmberTools installed (conda install -c conda-forge ambertools).
  antechamber, parmchk2, and tleap must be in PATH.
catalog-hidden: true
---

# Antechamber — Force Field Parameterization

## When to Use

- User needs GAFF/GAFF2 atom types and parameters for a small molecule
- User wants AM1-BCC or RESP partial atomic charges
- User is preparing a molecule for classical MD with AMBER or LAMMPS
- User needs to generate topology (prmtop) and coordinate (inpcrd) files

## Prerequisites

1. AmberTools installed (`antechamber --help`)
2. Input molecule structure (mol2, pdb, or Gaussian output for RESP)
3. For RESP charges: Gaussian output with `pop=mk iop(6/33=2)` ESP data

## Workflow Steps

### 1. Generate GAFF parameters with AM1-BCC charges

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "antechamber_param",
  "command": "bash parameterize.sh",
  "input_files": {
    "parameterize.sh": "<script content>",
    "molecule.pdb": "<molecule structure>"
  },
  "system_name": "ligand_param"
})
```

## Parameterization Script — AM1-BCC Charges

```bash
#!/bin/bash
set -e

# Step 1: Assign GAFF2 atom types and AM1-BCC charges
antechamber -i molecule.pdb -fi pdb \
            -o molecule.mol2 -fo mol2 \
            -c bcc -at gaff2 \
            -nc 0 -m 1 \
            -rn LIG

# Step 2: Check for missing parameters
parmchk2 -i molecule.mol2 -f mol2 \
         -o molecule.frcmod -a Y

# Step 3: Build topology with tleap
cat > tleap.in << 'EOF'
source leaprc.gaff2
LIG = loadmol2 molecule.mol2
loadamberparams molecule.frcmod
check LIG
saveamberparm LIG molecule.prmtop molecule.inpcrd
savemol2 LIG molecule_leap.mol2 1
quit
EOF

tleap -f tleap.in > tleap.log 2>&1
echo "Generated: molecule.prmtop molecule.inpcrd"
```

## Parameterization Script — RESP Charges

For higher-quality charges, use RESP from Gaussian ESP:

```bash
#!/bin/bash
set -e

# Step 1: Generate Gaussian input for ESP
antechamber -i molecule.pdb -fi pdb \
            -o molecule.gjf -fo gcrt \
            -gm "%mem=4GB" -gn "%nproc=8" \
            -ge "molecule.gesp" \
            -gk "#HF/6-31G* opt pop=mk iop(6/33=2)"

# Step 2: Run Gaussian (separate task)
# g16 molecule.gjf

# Step 3: Extract RESP charges from Gaussian output
antechamber -i molecule.log -fi gout \
            -o molecule.mol2 -fo mol2 \
            -c resp -at gaff2 \
            -nc 0 -m 1 -rn LIG

# Step 4: Check and build topology (same as AM1-BCC)
parmchk2 -i molecule.mol2 -f mol2 -o molecule.frcmod -a Y

cat > tleap.in << 'EOF'
source leaprc.gaff2
LIG = loadmol2 molecule.mol2
loadamberparams molecule.frcmod
check LIG
saveamberparm LIG molecule.prmtop molecule.inpcrd
quit
EOF

tleap -f tleap.in > tleap.log 2>&1
```

## Solvation with tleap

After parameterization, solvate the molecule:

```
source leaprc.water.tip3p
LIG = loadmol2 molecule.mol2
loadamberparams molecule.frcmod
solvateBox LIG TIP3PBOX 12.0
addIonsRand LIG Na+ 0 Cl- 0   # Neutralize
saveamberparm LIG solvated.prmtop solvated.inpcrd
quit
```

## Parameter Guidance

| Flag | Purpose |
|---|---|
| `-c bcc` | AM1-BCC charges (fast, good for most organic molecules) |
| `-c resp` | RESP charges (requires Gaussian ESP, higher quality) |
| `-at gaff2` | GAFF2 atom types (preferred over gaff) |
| `-nc 0` | Net charge of molecule |
| `-m 1` | Spin multiplicity |
| `-rn LIG` | Residue name (3 chars max) |
| `-fi / -fo` | Input/output format (pdb, mol2, gout, gcrt) |

## Common Pitfalls

1. **Wrong net charge** — `-nc` must match the actual molecular charge. Wrong charge gives wrong AM1-BCC charges.
2. **Missing parameters** — `parmchk2` with `-a Y` fills gaps by analogy but warns. Check `molecule.frcmod` for `ATTN` lines.
3. **Atom name conflicts** — tleap requires unique atom names within a residue. antechamber usually handles this.
4. **RESP without ESP** — RESP charges require a Gaussian calculation with `pop=mk iop(6/33=2)`. AM1-BCC does not.
5. **GAFF vs GAFF2** — use GAFF2 (`-at gaff2`, `leaprc.gaff2`) for improved parameters. Do not mix GAFF and GAFF2.
6. **Radical species** — antechamber struggles with radicals and metals. Consider manual parameterization.
7. **Large molecules** — AM1 optimization in antechamber can be slow for >100 atoms. Pre-optimize geometry.
