---
name: convergence_issues
description: Diagnose and fix SCF and ionic convergence failures in VASP and ORCA. Covers ALGO, mixing parameters, ISMEAR, NELM, EDIFFG, NSW, and IBRION settings.
---

# Convergence Issues Troubleshooting Skill

## When to Use

Use this skill when:
- A calculation finishes but did not converge (warnings in output)
- SCF (electronic) iterations hit NELM without converging
- Ionic relaxation oscillates or does not reach force threshold
- Energy keeps changing between ionic steps
- ORCA SCF or geometry optimization fails to converge

## Diagnostic Step

Always start by checking the convergence history:

```json
catgo_analyze(action: "convergence", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

This returns SCF energy per iteration and forces per ionic step, making it
easy to see whether the problem is electronic or ionic.

---

## SCF (Electronic) Convergence

### Symptoms
- "NELM reached" warning in VASP output
- Energy oscillates or diverges across SCF iterations
- ORCA prints "SCF NOT CONVERGED"

### VASP SCF Fixes

#### Fix 1: Change mixing algorithm (ALGO)

| ALGO value | Method | Best for |
|---|---|---|
| Normal | Davidson | Simple semiconductors, insulators |
| Fast | Davidson + RMM-DIIS | Default, most systems |
| All | Davidson + RMM-DIIS (combined) | Difficult metals, surfaces |
| Damped | Damped velocity | Very difficult convergence |
| VeryFast | RMM-DIIS only | Large systems (>500 atoms) |

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "ALGO": "All" }
})
```

#### Fix 2: Adjust charge density mixing (AMIX/BMIX)

Default values work for most bulk systems. For surfaces, slabs, molecules
in vacuum, or magnetic systems, reduce mixing:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: {
    "AMIX": 0.1,
    "BMIX": 0.01,
    "AMIX_MAG": 0.2,
    "BMIX_MAG": 0.01
  }
})
```

Lower AMIX = more conservative mixing = slower but more stable convergence.

#### Fix 3: Increase maximum SCF steps (NELM)

Default NELM is 60. If the SCF is converging but slowly:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "NELM": 200 }
})
```

#### Fix 4: Correct ISMEAR for your system type

| System type | ISMEAR | SIGMA |
|---|---|---|
| Metal | 1 (Methfessel-Paxton) | 0.2 |
| Semiconductor/insulator | 0 (Gaussian) | 0.05 |
| Molecule in box | 0 (Gaussian) | 0.01 |
| DOS calculation | -5 (tetrahedron) | N/A |

Using ISMEAR=-5 (tetrahedron) for metals with few k-points causes convergence
failures. Using ISMEAR=1 for insulators can cause incorrect occupations.

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "ISMEAR": 0, "SIGMA": 0.05 }
})
```

#### Fix 5: Start from a converged WAVECAR

If a similar calculation has converged, use its WAVECAR as starting point.
This is handled automatically by CatGo's workflow engine when chaining tasks.

### ORCA SCF Fixes

Add keywords to `orca_extra_keywords`:

| Problem | Fix keyword | Description |
|---|---|---|
| Slow convergence | `SlowConv` | Dampened SCF |
| Very slow | `VerySlowConv` | More conservative |
| Oscillating | `SOSCF` | Second-order SCF |
| Near-degenerate | `SmearTemp 5000` | Fermi smearing |
| Level shifting | `Shift 0.3` | Shift virtual orbitals up |

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "orca_extra_keywords": "SlowConv SOSCF" }
})
```

---

## Ionic (Geometry) Convergence

### Symptoms
- NSW reached without forces dropping below EDIFFG
- Total energy oscillates between ionic steps
- Atoms move back and forth between two configurations

### Fix 1: Adjust force convergence (EDIFFG)

VASP default EDIFFG=-0.05 eV/A is reasonable. If too tight:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "EDIFFG": -0.03 }
})
```

Negative EDIFFG = force criterion (recommended). Positive = energy criterion.

### Fix 2: Increase maximum ionic steps (NSW)

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "NSW": 300 }
})
```

### Fix 3: Change ionic optimizer (IBRION)

| IBRION | Method | Best for |
|---|---|---|
| 1 | Quasi-Newton (RMM-DIIS) | Near-minimum structures |
| 2 | Conjugate gradient | Far from minimum (default) |
| 3 | Damped MD | Very distorted structures |

If CG (IBRION=2) oscillates, switch to quasi-Newton:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "IBRION": 1 }
})
```

### Fix 4: Reduce step size (POTIM)

If atoms jump too far each step:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "POTIM": 0.1 }
})
```

Default POTIM is 0.5 for IBRION=1/2.

## Common Mistakes

- Fixing ionic convergence when the real problem is SCF (always check SCF first)
- Using tetrahedron smearing (ISMEAR=-5) for relaxation (only for static calcs)
- Setting EDIFFG too tight for the basis set quality
- Not checking if the structure is physically reasonable before tweaking params
