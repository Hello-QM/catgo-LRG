---
name: single_point
description: CP2K single point energy calculation. Uses GTH pseudopotentials, Gaussian-plane-wave (GPW) method, and DZVP basis sets for periodic DFT.
---

# CP2K Single Point Energy Skill

## When to Use

Use this skill when the user wants to:
- Calculate the total energy of a periodic system using CP2K
- Compute electronic density of states with CP2K
- Get forces on atoms without relaxation
- Benchmark different functionals or cutoffs for a crystal structure

CP2K uses the Gaussian and Plane Waves (GPW) method, which is efficient for
large periodic systems (100+ atoms). For molecular systems, prefer ORCA.

## Default Parameters

| Parameter | Default | Description |
|---|---|---|
| `software` | "cp2k" | Must be set to "cp2k" |
| `cp2k_functional` | "PBE" | XC functional |
| `cp2k_basis` | "DZVP-MOLOPT-SR-GTH" | Gaussian basis set |
| `cp2k_pseudo` | "GTH-PBE" | Pseudopotential family |
| `cp2k_cutoff` | 400 | Plane-wave cutoff in Ry |
| `cp2k_rel_cutoff` | 60 | Relative cutoff in Ry |
| `kpoints` | [1, 1, 1] | Gamma-point by default |

## MCP Tool Examples

### Basic single point energy

First, check the loaded structure:

```json
catgo_view(action: "get_state")
```

Create workflow and add single point task:

```json
catgo_workflow_v2(action: "create", params: {
  name: "TiO2 rutile single point"
})
```

```json
catgo_workflow_v2(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "single_point",
  params: {
    software: "cp2k",
    cp2k_functional: "PBE",
    cp2k_basis: "DZVP-MOLOPT-SR-GTH",
    cp2k_pseudo: "GTH-PBE",
    cp2k_cutoff: 400
  }
})
```

### With k-points for metals or small cells

```json
catgo_workflow_v2(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "single_point",
  params: {
    software: "cp2k",
    cp2k_functional: "PBE",
    cp2k_basis: "DZVP-MOLOPT-SR-GTH",
    cp2k_pseudo: "GTH-PBE",
    cp2k_cutoff: 500,
    kpoints: [4, 4, 4]
  }
})
```

### With DFT+U for transition metal oxides

For systems where standard DFT fails (e.g., NiO, FeO, MnO):

```json
catgo_workflow_v2(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "single_point",
  params: {
    software: "cp2k",
    cp2k_functional: "PBE",
    cp2k_basis: "DZVP-MOLOPT-SR-GTH",
    cp2k_pseudo: "GTH-PBE",
    cp2k_cutoff: 500,
    cp2k_dft_plus_u: true,
    cp2k_u_values: {"Ni": 6.4, "Fe": 4.0}
  }
})
```

### Hybrid functional (HSE06)

More accurate but significantly more expensive:

```json
catgo_workflow_v2(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "single_point",
  params: {
    software: "cp2k",
    cp2k_functional: "HSE06",
    cp2k_basis: "DZVP-MOLOPT-SR-GTH",
    cp2k_pseudo: "GTH-PBE",
    cp2k_cutoff: 500,
    cp2k_hfx_cutoff_radius: 6.0
  }
})
```

### Submit and get results

```json
catgo_workflow_v2(action: "submit", params: { workflow_id: "<wf_id>" })
```

```json
catgo_workflow_v2(action: "status", params: { workflow_id: "<wf_id>" })
```

```json
catgo_workflow_v2(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

## GTH Pseudopotentials

CP2K uses Goedecker-Teter-Hutter (GTH) pseudopotentials. The pseudopotential
family MUST match the functional:

| Functional | Pseudopotential |
|---|---|
| PBE | GTH-PBE |
| BLYP | GTH-BLYP |
| PBE0, HSE06 | GTH-PBE (same PP for hybrids) |
| SCAN | GTH-SCAN (if available, else GTH-PBE) |

### Basis set options

| Basis | Quality | Atoms | Use |
|---|---|---|---|
| SZV-MOLOPT-SR-GTH | Single-zeta | All | Quick test only |
| DZVP-MOLOPT-SR-GTH | Double-zeta | All | Production default |
| TZVP-MOLOPT-SR-GTH | Triple-zeta | Most | Accurate energetics |
| TZV2P-MOLOPT-SR-GTH | Triple-zeta+2pol | Main group | Benchmark |

The `-SR-` (short range) variants are optimized for condensed phase and are
preferred for periodic calculations. `-GTH` suffix means they match GTH
pseudopotentials.

## Cutoff Convergence

The plane-wave cutoff (`cp2k_cutoff`) controls the electron density grid. Test
convergence by running multiple single points:

```json
catgo_workflow_v2(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "single_point",
  task_id: "cut300",
  params: { software: "cp2k", cp2k_cutoff: 300 }
})
```

Repeat for 400, 500, 600 Ry. Energy should converge to within 1 meV/atom.

Typical converged values:
- Light elements (C, N, O): 400 Ry
- Transition metals: 500 Ry
- Hard pseudopotentials (F, O with certain PPs): 600 Ry

## Common Mistakes

- Mismatched basis/pseudopotential families (GTH-PBE basis with BLYP functional)
- Cutoff too low (unconverged energy, meaningless forces)
- Gamma-point k-mesh for a metal (need denser k-points)
- Using molecular basis sets (no -GTH suffix) with GTH pseudopotentials
- Forgetting spin polarization for magnetic systems (set `cp2k_spin_polarized: true`)
