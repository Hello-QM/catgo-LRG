---
name: combinatorial-substitution
description: >
  Use when the user asks for systematic element substitution, combinatorial
  materials screening, high-throughput composition search, or multi-site
  replacement across different element groups.
---

# Combinatorial Substitution

## Overview

Combinatorial substitution systematically replaces elements at specified
sites across multiple groups, generating all combinations for materials
discovery. Unlike simple doping (which replaces one element with another),
this tool creates the full Cartesian product of substitutions across groups.

Common applications:

- **High-entropy alloy screening**: test multiple elements at different sublattices
- **Perovskite composition search**: vary A-site and B-site cations independently
- **Catalyst optimization**: systematic dopant combinations
- **Battery cathode design**: screen transition metals at different Wyckoff sites

## MCP Tool: catgo_substitution

```json
{"tool": "catgo_substitution", "arguments": {
  "structure": "<current structure dict>",
  "groups": [
    {
      "target_indices": [0, 4, 8],
      "replacement_elements": ["Ti", "Zr", "Hf"]
    },
    {
      "target_indices": [1, 5, 9],
      "replacement_elements": ["Mn", "Fe", "Co"]
    }
  ],
  "max_structures": 500
}}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `structure` | Input structure dict | (required) |
| `groups` | Array of substitution groups | (required) |
| `groups[].target_indices` | Site indices to substitute in this group | (required) |
| `groups[].replacement_elements` | Elements to try at these sites | (required) |
| `max_structures` | Safety cap on total combinations | 500 |

**Total structures = product of replacement options per group.**
For the example above: 3 (group 1) x 3 (group 2) = 9 structures.

### Router: `/build/substitution` (POST)

## Combinatorics

The tool generates the Cartesian product across groups. Within each group,
all target sites receive the **same** element for a given combination.

| Groups | Elements per Group | Total Structures |
|--------|-------------------|-----------------|
| 1 group, 5 elements | 5 | 5 |
| 2 groups, 3 each | 3 x 3 | 9 |
| 2 groups, 5 each | 5 x 5 | 25 |
| 3 groups, 4 each | 4 x 4 x 4 | 64 |
| 3 groups, 6 each | 6 x 6 x 6 | 216 |

The `max_structures` cap (default 500) prevents accidental generation of
extremely large sets.

## Complete Workflow: Perovskite ABO3 Screening

### Step 1: Fetch a reference perovskite

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "SrTiO3", "source": "mp"
}}
```

### Step 2: Identify site indices

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Identify A-site (Sr) and B-site (Ti) atom indices from the structure.

### Step 3: Generate all A/B combinations

```json
{"tool": "catgo_substitution", "arguments": {
  "groups": [
    {
      "target_indices": [0],
      "replacement_elements": ["Sr", "Ba", "Ca", "La"]
    },
    {
      "target_indices": [1],
      "replacement_elements": ["Ti", "Zr", "Hf", "Mn", "Fe"]
    }
  ]
}}
```

This generates 4 x 5 = 20 perovskite compositions: SrTiO3, SrZrO3,
BaTiO3, LaFeO3, etc.

### Step 4: Screen with MLP, then refine with DFT

For 20 structures, use a two-stage workflow:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "params": {"name": "Perovskite ABO3 screening"}
}}
```

First relax all candidates with an ML potential:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "params": {
    "workflow_id": "<wf_id>",
    "task_type": "geo_opt",
    "params": {"software": "mlp", "mlp_model": "mace",
               "system_name": "perovskite-screen-mlp"}
  }
}}
```

Then run DFT on the most promising candidates.

## Difference from Doping (catgo_structure action: doping)

| Feature | Doping | Combinatorial Substitution |
|---------|--------|---------------------------|
| Purpose | Replace one element with another | Screen multiple compositions |
| Output | 1 structure (or enumerated configs) | N structures (Cartesian product) |
| Groups | Single host/dopant pair | Multiple independent groups |
| MCP tool | `catgo_structure(action: doping)` | `catgo_substitution` |
| Use case | Targeted modification | Systematic screening |

Use **doping** when you want to modify a single structure.
Use **substitution** when you want to generate a library of compositions.

## Common Pitfalls

1. Always check site indices with `catgo_view` before substituting.
   Atom indices depend on the specific structure and may change after
   supercell expansion or slab generation.
2. The Cartesian product can grow rapidly. 4 groups x 6 elements each =
   1296 structures. Use `max_structures` to cap output.
3. All sites within a group receive the **same** element in each
   combination. If you need different elements at different sites within
   the same group, split them into separate groups.
4. Generated structures are unrelaxed. The substituted atoms keep the
   original positions. Always run geometry optimization before comparing
   energies.
5. For transition metal substitutions in oxides, enable spin polarization
   (ISPIN=2) and consider DFT+U corrections.
6. Charge neutrality is not enforced. Substituting Ca2+ for La3+ requires
   compensating defects or a charged cell.
