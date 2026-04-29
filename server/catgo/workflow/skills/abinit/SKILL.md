---
name: abinit
description: >
  Generate and manage ABINIT DFT calculations. Use when the user requests
  ABINIT, or needs DFPT phonons, GW calculations, or BSE optical spectra.
compatibility: >
  Requires ABINIT installed on the HPC target. Pseudopotential files
  (PAW JTH or norm-conserving) must be available.
---

# ABINIT

## When to Use

- User explicitly requests ABINIT
- User needs DFPT (density-functional perturbation theory) phonons natively
- User needs GW quasiparticle calculations or BSE optical spectra
- User wants multi-dataset calculations in a single input file

## Prerequisites

1. ABINIT binaries accessible on HPC (`abinit --version`)
2. Pseudopotentials available (JTH PAW or PseudoDojo NC recommended)
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "ABINIT GW band gap"})
```

### 3. Add ABINIT task via shell

CatGo does not yet have a native ABINIT engine. Use `task_type: "shell"`.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "abinit_scf",
  "command": "abinit < abinit.files > abinit.log 2>&1",
  "input_files": {
    "abinit.in": "<input content>",
    "abinit.files": "<files file content>"
  },
  "system_name": "Si_GW"
})
```

When a `@register_engine("abinit")` is added, use `task_type: "geo_opt"` with `software: "abinit"`.

## Input File Template — SCF

```
# SCF ground state
ndtset 1

# System
natom  <natoms>
ntypat <ntypes>
typat  <type_list>
znucl  <Z_list>

acell  3*1.0
rprim
  <a1x> <a1y> <a1z>
  <a2x> <a2y> <a2z>
  <a3x> <a3y> <a3z>

xred
  <x1> <y1> <z1>
  <x2> <y2> <z2>

# Plane-wave basis
ecut    40.0    # Ha (= 2x Ry)
pawecutdg 80.0  # PAW fine grid

# K-points
ngkpt   <k1> <k2> <k3>
nshiftk 1
shiftk  0.0 0.0 0.0

# SCF
nstep   100
toldfe  1.0d-8   # Ha

# Smearing
occopt  3        # Fermi-Dirac
tsmear  0.002    # Ha (~0.05 eV)

# XC
ixc     11       # PBE
```

## The .files File

ABINIT uses a `.files` file listing input/output/pseudo paths:

```
abinit.in
abinit.out
abiniti
abinito
abinit_tmp
pseudo/Si.paw
```

Lines: input, output, root_input, root_output, tmp_dir, then one pseudo per atom type.

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| ecut | 30-50 Ha | In Hartree (1 Ha = 27.2 eV); check pseudo recommendations |
| pawecutdg | 2x ecut | PAW augmentation grid; only for PAW pseudos |
| toldfe | 1.0d-8 | Energy convergence in Ha |
| toldff | 1.0d-5 | Force convergence in Ha/Bohr (for relaxation) |
| ngkpt | auto from cell | Monkhorst-Pack grid |
| occopt | 3 (FD) or 7 (Gaussian) | Smearing type |
| ionmov | 2 (BFGS) | Ion relaxation algorithm |
| optcell | 0 (ions) / 2 (full) | Cell optimization level |

## Multi-Dataset Calculations

ABINIT supports chaining calculations in one input via `ndtset`:

```
ndtset 3

# Dataset 1: SCF
toldfe1 1.0d-8

# Dataset 2: NSCF for DOS
iscf2    -2
tolwfr2  1.0d-12
getden2  1

# Dataset 3: DFPT phonons
rfphon3  1
nqpt3    1
qpt3     0.0 0.0 0.0
toldfe3  1.0d-10
getden3  1
getwfk3  1
```

## Common Pitfalls

1. **ecut in Hartree, not eV** — ABINIT uses Hartree (1 Ha = 27.2 eV). A 40 Ha cutoff is ~1088 eV.
2. **Coordinates default to reduced (xred)** — use `xred` (fractional) or `xcart` (Bohr). Not Angstrom.
3. **Missing .files file** — ABINIT reads file paths from stdin or a .files file; forgetting it causes silent failure
4. **PAW augmentation grid** — if using PAW pseudos, `pawecutdg` must be set (typically 2x ecut)
5. **GW convergence** — GW calculations need many empty bands (`nband`) and careful `ecuteps` convergence
6. **Large tmp files** — ABINIT writes wave functions to `_TMP`; ensure sufficient disk space
