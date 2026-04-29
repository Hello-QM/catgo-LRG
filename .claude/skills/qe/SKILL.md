---
name: quantum-espresso
description: >
  Generate and manage Quantum ESPRESSO (pw.x) DFT calculations. Use when the user requests
  QE, Quantum ESPRESSO, pw.x, or plane-wave pseudopotential calculations outside VASP.
compatibility: >
  Requires Quantum ESPRESSO installed on the HPC target. Pseudopotential files (UPF)
  must be available in the configured pseudo_dir.
---

# Quantum ESPRESSO (pw.x)

## When to Use

- User explicitly requests Quantum ESPRESSO / QE / pw.x
- User needs norm-conserving or ultrasoft pseudopotentials (not PAW-only like VASP)
- User wants open-source plane-wave DFT
- User needs ph.x phonon calculations (hand off to `analysis/phonopy/SKILL.md` for post-processing)

## Prerequisites

1. QE binaries (`pw.x`, `pp.x`) accessible on HPC
2. Pseudopotential library (SSSP or PseudoDojo recommended) in a known directory
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "QE relaxation - TiO2"})
```

### 3. Add QE task

CatGo does not yet have a native QE engine. Use `task_type: "shell"` with input file generation.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "qe_relax",
  "command": "pw.x -in relax.in > relax.out",
  "input_files": {
    "relax.in": "<pw.x input content>"
  },
  "system_name": "TiO2_relax"
})
```

When a `@register_engine("qe")` is added to CatGo, use `task_type: "geo_opt"` with `software: "qe"` instead.

### 4. Submit

```
catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Input File Template — SCF

```
&CONTROL
  calculation = 'scf'
  pseudo_dir  = './pseudo/'
  outdir      = './tmp/'
  tprnfor     = .true.
  tstress     = .true.
/
&SYSTEM
  ibrav       = 0
  nat         = <natoms>
  ntyp        = <ntypes>
  ecutwfc     = 60.0
  ecutrho     = 480.0
  occupations = 'smearing'
  smearing    = 'mv'
  degauss     = 0.02
/
&ELECTRONS
  conv_thr    = 1.0d-6
  mixing_beta = 0.3
/
ATOMIC_SPECIES
  <element>  <mass>  <element>.UPF
CELL_PARAMETERS angstrom
  <a1x> <a1y> <a1z>
  <a2x> <a2y> <a2z>
  <a3x> <a3y> <a3z>
ATOMIC_POSITIONS angstrom
  <element> <x> <y> <z>
K_POINTS automatic
  <k1> <k2> <k3> 0 0 0
```

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| ecutwfc | 40-80 Ry | Depends on pseudopotential; SSSP suggests per-element values |
| ecutrho | 4-12x ecutwfc | NC: 4x, US: 8-12x |
| conv_thr | 1.0d-6 | SCF convergence; tighten to 1.0d-8 for phonons |
| mixing_beta | 0.3-0.7 | Lower for metals/magnetic systems |
| K_POINTS | auto from cell | ~0.03 A^-1 spacing, Gamma for molecules |
| smearing | 'mv' | Marzari-Vanderbilt cold smearing; use 'gaussian' for insulators |

## Relaxation-Specific Parameters

Add to input for geometry optimization:

```
&CONTROL
  calculation = 'relax'    ! ions only
  ! or 'vc-relax'          ! ions + cell
/
&IONS
  ion_dynamics = 'bfgs'
/
&CELL                      ! only for vc-relax
  cell_dynamics = 'bfgs'
  press = 0.0
/
```

- Use `relax` for slabs (fixed cell), `vc-relax` for bulk
- For slabs: constrain bottom atoms with `if_pos` flags (0 = fixed)

## Common Pitfalls

1. **ecutrho too low for US pseudopotentials** — NC needs 4x ecutwfc, US needs 8-12x. Check pseudopotential header.
2. **Mixing divergence for metals** — reduce `mixing_beta` to 0.1-0.2 and try `mixing_mode = 'local-TF'`
3. **Wrong ibrav** — always use `ibrav = 0` with explicit CELL_PARAMETERS to avoid ambiguity
4. **Missing pseudo files** — ensure UPF filenames match ATOMIC_SPECIES exactly (case-sensitive)
5. **Slab vacuum too thin** — need at least 15 A vacuum; add `assume_isolated = '2D'` for 2D corrections
6. **K-points along vacuum direction** — slabs must use k3=1 (single k-point in z)
