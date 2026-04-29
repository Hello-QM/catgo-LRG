---
name: lammps-router
description: >
  Route LAMMPS molecular dynamics requests to force-field-specific sub-skills.
  Use when the user requests LAMMPS with a specific potential type (DeePMD, ReaxFF).
compatibility: >
  Requires LAMMPS installed on HPC. Specific packages must be compiled in
  depending on the force field (e.g., DEEPMD for DeePMD, REAXFF for ReaxFF).
---

# LAMMPS Router

Route LAMMPS requests to the appropriate force-field sub-skill.

## Routing Table

| User intent | Route to |
|---|---|
| LAMMPS with DeePMD potential / DP model | `deepmd/SKILL.md` |
| LAMMPS with ReaxFF reactive force field | `reaxff/SKILL.md` |
| General LAMMPS MD (EAM, Tersoff, LJ) | Use CatGo's built-in MD task type |

## Shared Policies

1. **Always specify units** — LAMMPS has multiple unit systems. DeePMD uses `metal`, ReaxFF uses `real`.
2. **Timestep must match units** — `metal`: 1 fs = 0.001 ps; `real`: 1 fs.
3. **Dump trajectory** — always include `dump` command for trajectory output.
4. **Thermo output** — always include `thermo` and `thermo_style` for monitoring.
5. **Restart files** — write restart files periodically for long simulations.

## Quick Decision Guide

- "MD with machine learning potential" / "DP-MD" → `deepmd/SKILL.md`
- "Reactive MD" / "ReaxFF" / "combustion" / "oxidation" → `reaxff/SKILL.md`
- "Simple MD" / "LJ" / "EAM" / "metal MD" → use CatGo built-in MD task
- "Convert trajectory" → `../data/dpdata/SKILL.md`

## General LAMMPS via CatGo (Built-in)

For standard force fields, CatGo's MD engine can be used directly:

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "md",
  "software": "lammps",
  "structure": "<json>",
  "temperature": 300,
  "timestep": 1.0,
  "nsteps": 100000,
  "system_name": "Cu_melt"
})
```

For specialized potentials (DeePMD, ReaxFF), use the sub-skills.
