---
name: convergence-test
description: >
  Use when the user asks to test ENCUT convergence, k-point convergence,
  or any parameter sweep to determine converged computational settings.
---

# Convergence Testing

## Purpose

Before production calculations, verify that results are converged with
respect to key numerical parameters. The two most important are:

1. **ENCUT** (planewave cutoff energy) -- controls basis set completeness
2. **KPOINTS** (k-point mesh density) -- controls Brillouin zone sampling

Convergence is reached when the target property (energy, forces, band gap)
changes by less than a threshold (typically 1 meV/atom for energy).

## Fan-Out Pattern

Convergence tests use a fan-out DAG: one input structure feeds into
multiple independent `single_point` calculations with different parameter
values.

```
                   +--> single_point(ENCUT=300)
                   |
structure_input ---+--> single_point(ENCUT=400)
                   |
                   +--> single_point(ENCUT=500)
                   |
                   +--> single_point(ENCUT=600)
                   |
                   +--> single_point(ENCUT=700)
```

Use `single_point` (not `geo_opt`) to isolate the parameter effect without
geometry changes confounding the comparison.

## MCP Workflow: ENCUT Convergence

### Step 1: Create workflow

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "ENCUT convergence - TiO2"
}}
```

### Step 2: Add single_point tasks at each ENCUT

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_conv",
  "task_type": "single_point",
  "params": {"software": "vasp", "ENCUT": 300, "system_name": "ENCUT=300"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_conv",
  "task_type": "single_point",
  "params": {"software": "vasp", "ENCUT": 400, "system_name": "ENCUT=400"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_conv",
  "task_type": "single_point",
  "params": {"software": "vasp", "ENCUT": 500, "system_name": "ENCUT=500"}
}}
```

Repeat for ENCUT = 600, 700, 800.

### Step 3: Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_conv"
}}
```

### Step 4: Check results

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "get_result", "workflow_id": "wf_conv", "task_id": "task_encut300"
}}
```

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "convergence", "workflow_id": "wf_conv"
}}
```

## MCP Workflow: KPOINTS Convergence

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_conv",
  "task_type": "single_point",
  "params": {"software": "vasp", "ENCUT": 520, "KPOINTS": [2,2,1],
             "system_name": "2x2x1"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_conv",
  "task_type": "single_point",
  "params": {"software": "vasp", "ENCUT": 520, "KPOINTS": [4,4,1],
             "system_name": "4x4x1"}
}}
```

Repeat for 6x6x1, 8x8x1. Use the converged ENCUT from the previous test.

## Python API

### ENCUT Convergence

```python
from catgo.workflow import Workflow

wf = Workflow("ENCUT convergence - TiO2")
inp = wf.add_task("structure_input", structure=tio2_json)

encut_values = [300, 400, 500, 600, 700, 800]
tasks = {}
for encut in encut_values:
    tasks[encut] = wf.add_task("single_point",
        structure=inp.output.structure,
        software="vasp", ENCUT=encut,
        system_name=f"ENCUT={encut}")

wf.submit()
```

### KPOINTS Convergence

```python
wf = Workflow("KPOINTS convergence - TiO2 slab")
inp = wf.add_task("structure_input", structure=tio2_slab_json)

kpoints_list = [[2,2,1], [4,4,1], [6,6,1], [8,8,1], [10,10,1]]
for kp in kpoints_list:
    label = f"{kp[0]}x{kp[1]}x{kp[2]}"
    wf.add_task("single_point",
        structure=inp.output.structure,
        software="vasp", ENCUT=520, KPOINTS=kp,
        system_name=label)

wf.submit()
```

## Convergence Criteria

| Property | Threshold | Typical Converged ENCUT |
|----------|-----------|------------------------|
| Total energy | 1 meV/atom | 1.3x max(ENMAX) in POTCAR |
| Forces | 5 meV/A | Same as energy |
| Band gap | 10 meV | May need higher ENCUT |
| Stress tensor | 0.1 kbar | Often needs 1.5x ENMAX |

## Recommended ENCUT Values by Element Type

| System | Starting ENCUT Range | Notes |
|--------|---------------------|-------|
| Simple metals (Cu, Pt) | 300-500 | Usually converges quickly |
| Oxides (TiO2, RuO2) | 400-600 | O has high ENMAX |
| Nitrides, carbides | 400-600 | N, C have moderate ENMAX |
| F-containing | 500-800 | F has very high ENMAX |

## Two-Stage Strategy

1. **ENCUT first**: Fix KPOINTS at a moderate value (e.g., 4x4x4),
   sweep ENCUT. Pick the converged ENCUT.
2. **KPOINTS second**: Fix ENCUT at converged value, sweep KPOINTS.
   Pick the converged mesh.

This avoids the combinatorial explosion of testing all ENCUT x KPOINTS pairs.

## Common Pitfalls

1. Always use `single_point`, not `geo_opt`. Geometry changes at different
   ENCUT introduce noise that masks the convergence behavior.
2. For slab models, only converge the in-plane k-points (e.g., NxNx1).
   The vacuum direction needs only 1 k-point.
3. ENCUT should be at least 1.3x the maximum ENMAX in the POTCAR.
   Check POTCAR ENMAX values before choosing the test range.
4. Report energy per atom (E_total / N_atoms), not total energy,
   for meaningful comparison across different systems.
5. Always plot E vs parameter -- convergence should be monotonic.
   Non-monotonic behavior suggests other issues (e.g., SCF convergence).
