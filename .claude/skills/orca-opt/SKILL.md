---
name: orca-opt
description: ORCA geometry optimization. Handles method/basis selection, dispersion corrections, solvent models, and convergence settings.
---

# ORCA Geometry Optimization Skill

## When to Use

Use this skill when the user wants to:
- Optimize a molecular geometry with ORCA
- Find the minimum energy structure of a molecule
- Relax a molecular cluster or complex

Do NOT use for periodic systems (use VASP or CP2K instead).

## Default Parameters

| Parameter | Default | Description |
|---|---|---|
| `orca_method` | B3LYP | DFT functional |
| `orca_basis` | def2-SVP | Basis set |
| `charge` | 0 | Total charge |
| `multiplicity` | 1 | Spin multiplicity (2S+1) |
| `orca_extra_keywords` | "" | Additional ORCA keywords |

## MCP Tool Examples

### Basic optimization

First, confirm the structure is loaded:

```json
catgo_view(action: "get_state")
```

Create workflow and add optimization task:

```json
catgo_workflow_engine(action: "create", params: {
  name: "Benzene optimization"
})
```

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 1
  }
})
```

### With dispersion correction (D3BJ)

For systems with non-covalent interactions (dimers, host-guest, protein-ligand):

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-TZVP",
    orca_extra_keywords: "D3BJ",
    charge: 0,
    multiplicity: 1
  }
})
```

### With solvent (CPCM)

For solution-phase chemistry:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    orca_extra_keywords: "CPCM(Water)",
    charge: 0,
    multiplicity: 1
  }
})
```

### Tight optimization convergence

For publication-quality geometries or pre-frequency calculations:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-TZVP",
    orca_extra_keywords: "TightOpt D3BJ",
    charge: 0,
    multiplicity: 1
  }
})
```

### Open-shell system (radical)

For a doublet radical like NO2:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  params: {
    software: "orca",
    orca_method: "UB3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 2
  }
})
```

### Submit the workflow

```json
catgo_workflow_engine(action: "submit", params: {
  workflow_id: "<wf_id>"
})
```

### Check status

```json
catgo_workflow_engine(action: "status", params: {
  workflow_id: "<wf_id>"
})
```

### Get results

```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

## Dispersion Corrections

| Keyword | Method | When to use |
|---|---|---|
| `D3BJ` | Grimme D3 with Becke-Johnson damping | Default choice for dispersion |
| `D3` | Grimme D3 with zero damping | Legacy, use D3BJ instead |
| `D4` | Grimme D4 | Newer, slightly better for metals |

Always include dispersion for: molecular dimers, adsorption complexes,
conformational searches, anything with pi-stacking or H-bonding.

## Basis Set Ladder

| Basis | Quality | Cost | Use |
|---|---|---|---|
| def2-SVP | Double-zeta | Low | Screening, initial opt |
| def2-TZVP | Triple-zeta | Medium | Production geometry |
| def2-TZVPP | Triple-zeta+pol | High | Accurate energetics |
| def2-QZVPP | Quadruple-zeta | Very high | Benchmark only |

Strategy: optimize with def2-SVP, then single-point with def2-TZVP for energy.

## SCF Convergence Issues

If ORCA SCF does not converge, try adding to `orca_extra_keywords`:
- `SlowConv` -- dampened SCF for difficult cases
- `VerySlowConv` -- even more conservative
- `SOSCF` -- second-order SCF (helps for transition metals)
- `SmearTemp 5000` -- Fermi smearing for near-degenerate orbitals

## Common Mistakes

- Forgetting dispersion for non-covalent systems (huge geometry errors)
- Using restricted (R) method for open-shell (use UB3LYP, not B3LYP)
- Basis set too large for optimization (optimize with SVP, refine energy with TZVP)
- Not checking for imaginary frequencies after optimization
