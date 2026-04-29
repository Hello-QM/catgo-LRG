---
name: orca-router
description: Routes ORCA calculation requests to opt, neb_ts, or freq sub-skills. Enforces ORCA-specific policies for method, basis set, charge, and multiplicity.
---

# ORCA Router Skill

## When to Use

Use this skill when the user requests any ORCA-based calculation. Route to the
appropriate sub-skill based on what the user needs:

| User intent | Route to |
|---|---|
| Geometry optimization, energy minimization | `orca/opt` |
| Transition state, NEB, reaction barrier | `orca/neb_ts` |
| Vibrational frequencies, IR spectrum, thermochemistry | `orca/freq` |

## ORCA-Specific Policies

### Method and Basis Set Defaults

Always set `software: "orca"` in workflow node params. Default method/basis
combinations by use case:

| Use case | Method | Basis | Notes |
|---|---|---|---|
| General organic | B3LYP | def2-SVP | Good balance of cost/accuracy |
| Production organic | B3LYP | def2-TZVP | Publication quality |
| Transition metals | PBE0 | def2-SVP | Better for d-electrons |
| Weak interactions | B3LYP-D3BJ | def2-TZVP | Dispersion-corrected |
| Quick screening | HF-3c | (built-in) | Composite, very fast |
| Accurate energies | DLPNO-CCSD(T) | cc-pVTZ | Gold standard, expensive |

### Charge and Multiplicity

ORCA requires explicit charge and multiplicity for every calculation. Always ask
the user or infer from the structure:

- Neutral closed-shell: `charge: 0, multiplicity: 1`
- Radical (one unpaired e-): `charge: 0, multiplicity: 2`
- Anion: `charge: -1, multiplicity: 1` (or 2 if radical anion)
- Cation: `charge: 1, multiplicity: 1` (or 2 if radical cation)
- Transition metal complexes: determine from d-electron count and ligand field

If unsure, ask the user. Never guess multiplicity for open-shell systems.

### Solvent Models

ORCA supports implicit solvation via CPCM:

```
orca_extra_keywords: "CPCM(Water)"
```

Common solvents: `Water`, `Acetonitrile`, `DMSO`, `THF`, `Toluene`, `DCM`.

## MCP Tool Examples

### Check what the user has loaded

```json
catgo_view(action: "get_state")
```

Always check the viewer state first to confirm a molecular structure is loaded
(not a periodic crystal -- ORCA is for molecular calculations).

### Create an ORCA optimization workflow

```json
catgo_workflow_engine(action: "create", params: {
  name: "Ethanol B3LYP optimization"
})
```

Then add an ORCA geo_opt task (see `orca/opt` skill for full details):

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

### Create an ORCA frequency workflow

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "freq",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 1
  }
})
```

### Opt + Freq chain (common pattern)

After creating the workflow, add both tasks and connect them:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  task_id: "opt1",
  params: { software: "orca", orca_method: "B3LYP", orca_basis: "def2-SVP",
            charge: 0, multiplicity: 1 }
})
```

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "freq",
  depends_on: ["opt1"],
  params: { software: "orca", orca_method: "B3LYP", orca_basis: "def2-SVP",
            charge: 0, multiplicity: 1 }
})
```

## Routing Decision Tree

1. Does the user want to find a transition state or reaction barrier?
   - YES -> route to `orca/neb_ts`
2. Does the user want vibrational frequencies, IR spectrum, or thermochemistry?
   - YES -> route to `orca/freq`
3. Does the user want to optimize a geometry or get an energy?
   - YES -> route to `orca/opt`
4. Unsure? Ask the user what property they need.

## Common Mistakes

- Using ORCA for periodic systems (ORCA is molecular only -- use VASP or CP2K)
- Forgetting charge/multiplicity (ORCA will fail or give wrong results)
- Using too large a basis for initial screening (start with def2-SVP)
- Not including dispersion for systems with non-covalent interactions
