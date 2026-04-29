---
name: moire-superlattice
description: >
  Use when the user asks to create a moire pattern, twisted bilayer structure,
  magic angle graphene, or any twisted 2D heterostructure.
---

# Moire Superlattice

## Overview

A moire superlattice forms when two identical 2D layers are stacked with a
relative twist angle. The resulting interference pattern creates a periodic
supercell with properties that depend strongly on the twist angle.

Common applications:

- **Twisted bilayer graphene (TBG)**: magic-angle superconductivity (~1.1 deg)
- **Twisted TMDs**: MoS2/MoS2, WSe2/WSe2 moire excitons
- **Flat-band engineering**: correlated electron physics
- **Strain-engineered devices**: tunable band gaps

## MCP Tools

### catgo_moire_search -- Find commensurate angles

```json
{"tool": "catgo_moire_search", "arguments": {
  "structure": "<current viewer structure>",
  "max_angle": 30,
  "tolerance": 0.01
}}
```

Searches for twist angles that produce commensurate superlattices (exact
periodic boundary conditions). Returns a list of angles with supercell
sizes, atom counts, and lattice mismatch.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `structure` | 2D monolayer structure (auto-fetched from viewer) | (required) |
| `max_angle` | Maximum twist angle to search (degrees) | 30 |
| `tolerance` | Commensurability tolerance | 0.01 |

### catgo_moire_build -- Build the twisted bilayer

```json
{"tool": "catgo_moire_build", "arguments": {
  "structure": "<current viewer structure>",
  "angle": 21.79,
  "interlayer_distance": 3.35
}}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `structure` | 2D monolayer structure | (required) |
| `angle` | Twist angle in degrees (from search results) | (required) |
| `interlayer_distance` | Distance between layers in Angstroms | 3.35 |

### Router: `/moire/search` (POST), `/moire/build` (POST)

## Complete Workflow: Twisted Bilayer Graphene

### Step 1: Fetch graphene monolayer

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "C", "source": "mc3d"
}}
```

Or load a graphene structure from file.

### Step 2: Search for commensurate angles

```json
{"tool": "catgo_moire_search", "arguments": {
  "max_angle": 10,
  "tolerance": 0.01
}}
```

The result lists angles sorted by supercell size. Small angles produce
very large supercells (thousands of atoms).

### Step 3: Build the moire structure

Pick an angle from the search results:

```json
{"tool": "catgo_moire_build", "arguments": {
  "angle": 5.09,
  "interlayer_distance": 3.35
}}
```

### Step 4: Verify

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Check: two layers visible, correct interlayer spacing, moire pattern
in the xy plane.

### Step 5: Relax (optional -- requires ML potential for large cells)

Magic-angle TBG (~1.1 deg) has ~11,000+ atoms. Use an MLP for relaxation:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "params": {"name": "TBG moire relaxation"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "params": {
    "workflow_id": "<wf_id>",
    "task_type": "geo_opt",
    "params": {"software": "mlp", "mlp_model": "mace",
               "system_name": "TBG-5.09deg"}
  }
}}
```

## Angle Selection Guide

| Angle (deg) | Approx. Atoms (graphene) | Notes |
|-------------|--------------------------|-------|
| 21.79 | ~28 | Smallest commensurate, good for testing |
| 13.17 | ~76 | Small, DFT-feasible |
| 9.43 | ~148 | Moderate |
| 5.09 | ~508 | Large, MLP recommended |
| 3.89 | ~868 | Very large |
| 1.08 | ~11,164 | Magic angle, MLP or tight-binding only |

## Common Pitfalls

1. Always start from a **monolayer** (single 2D layer). If you have a bulk
   structure, cut it down to one layer first.
2. Small twist angles produce very large supercells. Check atom count from
   `catgo_moire_search` before building.
3. The interlayer distance for graphene is ~3.35 A. For TMDs it is typically
   ~6.1-6.5 A (layer center to center). Use appropriate values.
4. Only commensurate angles from the search results give exact periodic
   boundary conditions. Arbitrary angles require approximation and may
   have significant strain.
5. DFT calculations on moire structures larger than ~200 atoms typically
   require ML potentials or tight-binding methods. Standard DFT is
   impractical for magic-angle TBG.
6. Van der Waals corrections (DFT-D3, rVV10) are essential for accurate
   interlayer interactions.
