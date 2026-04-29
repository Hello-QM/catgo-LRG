---
name: vasp_errors
description: Diagnose and fix common VASP errors including ZBRENT, BRMIX, EDDDAV, VERY BAD NEWS, POTCAR mismatch, and memory errors.
---

# VASP Error Troubleshooting Skill

## When to Use

Use this skill when a VASP calculation has failed with a recognized error
message. These are runtime errors from the VASP executable, distinct from
convergence issues (see `convergence_issues` skill) and CatGo engine errors
(see `workflow_errors` skill).

## Diagnostic Steps

### Step 1: Get the error message

```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

Or check the step-level error:

```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

### Step 2: Match the error and apply fix

## Error Reference

### ZBRENT: Fatal error in bracketing

**Cause:** VASP cannot find the electronic groundstate within the bracketing
interval during volume/cell relaxation (ISIF=3 or ISIF=7).

**Fix:**
```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: {
    "IBRION": 1,
    "EDIFF": 1e-6,
    "NELM": 200,
    "NSW": 200
  }
})
```

Then retry:
```json
catgo_workflow_engine(action: "retry", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

Alternative: switch from `IBRION=2` (CG) to `IBRION=1` (quasi-Newton), or
reduce `POTIM` from 0.5 to 0.1.

### BRMIX: Very serious problems

**Cause:** Charge density mixing fails. Common with slabs, surfaces, and
systems with vacuum regions.

**Fix:**
```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: {
    "ALGO": "All",
    "AMIX": 0.1,
    "BMIX": 0.01,
    "AMIX_MAG": 0.2,
    "BMIX_MAG": 0.01
  }
})
```

For severe cases, also add `LREAL = .FALSE.` and increase `NELM`.

### EDDDAV: Sub-space rotation failed / warning

**Cause:** Davidson iterative diagonalization failed. Common for systems with
many bands near the Fermi level (metals, small-gap semiconductors).

**Fix:**
```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: {
    "ALGO": "All"
  }
})
```

`ALGO=All` uses a combination of Davidson and RMM-DIIS that is more robust.
If that still fails, try `ALGO=Damped`.

### VERY BAD NEWS: Internal error in subroutine

**Cause:** Usually POSCAR has overlapping atoms (two atoms at the same
position) or the structure is severely distorted.

**Fix:**
1. Check the structure for overlapping atoms:
```json
catgo_view(action: "get_state")
```

2. If atoms overlap, fix the structure:
```json
catgo_structure(action: "delete", indices: [<overlapping_index>])
```

3. If the structure is distorted from a previous failed relaxation, reload
   the original structure and restart.

### POTCAR mismatch / POTCAR not found

**Cause:** The pseudopotential file does not match the elements in POSCAR,
or the POTCAR path on the HPC is not configured correctly.

**Fix:**
1. Check system configuration:
```json
catgo_system(action: "status")
```

2. Verify the element order matches. If the user has added/removed elements,
   the POTCAR needs to be regenerated. The CatGo engine handles this
   automatically, but manual HPC runs may have stale POTCARs.

3. Check that `VASP_PP_PATH` is set on the HPC.

### Memory errors (SBROUTINE / segfault / killed by OOM)

**Cause:** Not enough memory for the calculation. Common with large systems,
high ENCUT, or too many k-points.

**Fix options:**

Reduce memory usage:
```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: {
    "NCORE": 4,
    "KPAR": 2,
    "LREAL": ".TRUE.",
    "LWAVE": ".FALSE.",
    "LCHARG": ".FALSE."
  }
})
```

Or request more resources in the run config (increase nodes/memory).

### RSPHER: Internal error

**Cause:** Augmentation sphere overlap. Atoms are too close together.

**Fix:** Similar to VERY BAD NEWS -- check for overlapping or very close atoms.
Sometimes caused by too-aggressive ionic relaxation. Reduce `POTIM`:

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "POTIM": 0.1 }
})
```

### PRICEL: Internal error / symmetry detection

**Cause:** VASP symmetry detection fails on distorted or defective structures.

**Fix:**
```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "SYMPREC": 1e-4, "ISYM": 0 }
})
```

Setting `ISYM=0` disables symmetry entirely (safe but slower).

## General Recovery Pattern

For any VASP error: diagnose (get error from task result), modify parameters,
retry, then verify. If the same error recurs after two attempts, the structure
itself may be problematic. If errors appear on every system, the HPC
environment may be misconfigured -- route to `workflow_errors`.
