---
name: heterostructure
description: >
  Use when the user asks to build a heterostructure, interface, van der Waals
  stack, substrate-film system, or lattice-matched bilayer from two different
  materials.
---

# Heterostructure Assembly

## Overview

A heterostructure is a layered stack of two different materials joined at an
interface. The Zur-McGill (ZSL) algorithm finds superlattice matches that
minimize lattice mismatch between substrate and film.

Common applications:

- **Catalysis**: oxide support + metal film (TiO2/Pt, Al2O3/Pd)
- **Electronics**: semiconductor junctions (GaAs/AlAs, Si/Ge)
- **2D vdW stacks**: graphene/hBN, MoS2/WSe2
- **Energy**: electrode/electrolyte interfaces for batteries
- **Photocatalysis**: type-II heterojunctions for charge separation

## MCP Tools

### catgo_hetero_search -- Find lattice-matched superlattices

```json
{"tool": "catgo_hetero_search", "arguments": {
  "substrate": {"<pymatgen structure dict>": "..."},
  "film": {"<pymatgen structure dict>": "..."},
  "params": {
    "substrate_miller": [0, 0, 1],
    "film_miller": [0, 0, 1],
    "max_area": 400,
    "max_area_ratio_tol": 0.09,
    "max_length_tol": 0.09,
    "max_angle_tol": 0.09,
    "max_results": 20,
    "mode": "bulk"
  }
}}
```

Returns matches sorted by area, with available terminations for each match.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `substrate` | Substrate structure dict | (required) |
| `film` | Film structure dict | (required) |
| `substrate_miller` | Substrate surface orientation | [0,0,1] |
| `film_miller` | Film surface orientation | [0,0,1] |
| `max_area` | Maximum supercell area (A^2) | 400 |
| `max_area_ratio_tol` | Area ratio tolerance | 0.09 |
| `max_length_tol` | Length mismatch tolerance | 0.09 |
| `max_angle_tol` | Angle mismatch tolerance | 0.09 |
| `max_results` | Max number of matches to return | 20 |
| `mode` | `"bulk"` or `"slab"` input mode | "bulk" |

### catgo_hetero_build -- Build the interface

```json
{"tool": "catgo_hetero_build", "arguments": {
  "substrate": {"<pymatgen structure dict>": "..."},
  "film": {"<pymatgen structure dict>": "..."},
  "match": {"match_id": 0},
  "termination_index": 0,
  "params": {
    "gap": 2.0,
    "vacuum": 20.0,
    "substrate_thickness": 10.0,
    "film_thickness": 10.0,
    "twist_angle": 0.0
  }
}}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `match` | Match from search results (`match_id`) | (required) |
| `termination_index` | Which termination to use | 0 |
| `gap` | Interface gap in Angstroms | 2.0 |
| `vacuum` | Vacuum above the slab in Angstroms | 20.0 |
| `substrate_thickness` | Substrate slab thickness | 10.0 |
| `film_thickness` | Film slab thickness | 10.0 |
| `twist_angle` | In-plane rotation of the film | 0.0 |

### catgo_hetero_build_intermat -- One-step build (JARVIS pipeline)

An alternative builder that does search + build in one step using the
intermat/JARVIS method. Useful when you want a quick result without
separately inspecting matches.

```json
{"tool": "catgo_hetero_build_intermat", "arguments": {
  "substrate": {"<pymatgen structure dict>": "..."},
  "film": {"<pymatgen structure dict>": "..."},
  "params": {
    "substrate_miller": [0, 0, 1],
    "film_miller": [0, 0, 1],
    "separation": 3.0,
    "vacuum": 25.0
  }
}}
```

### Router: `/heterostructure/search` (POST), `/heterostructure/build` (POST), `/heterostructure/build-intermat` (POST), and more

Additional endpoints: `/batch-build`, `/build-manual`, `/search-lateral`,
`/build-lateral`, `/grid-scan`.

## Complete Workflow: TiO2/Pt Interface

### Step 1: Fetch both materials

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "TiO2", "source": "mp"
}}
```

Save this structure, then fetch the second:

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Pt", "source": "mp"
}}
```

### Step 2: Search for lattice matches

```json
{"tool": "catgo_hetero_search", "arguments": {
  "substrate": "<TiO2 structure>",
  "film": "<Pt structure>",
  "params": {
    "substrate_miller": [1, 1, 0],
    "film_miller": [1, 1, 1],
    "max_area": 200
  }
}}
```

Review the returned matches. Each lists:
- Superlattice area
- Strain (length and angle mismatch)
- Available terminations (e.g., O-terminated vs Ti-terminated)

### Step 3: Build the interface

Select the best match (smallest area with acceptable strain):

```json
{"tool": "catgo_hetero_build", "arguments": {
  "substrate": "<TiO2 structure>",
  "film": "<Pt structure>",
  "match": {"match_id": 0},
  "termination_index": 0,
  "params": {
    "gap": 2.5,
    "vacuum": 20.0,
    "substrate_thickness": 12.0,
    "film_thickness": 10.0
  }
}}
```

### Step 4: Verify

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Check: correct interface geometry, appropriate vacuum, no overlapping
atoms at the interface.

### Step 5: Relax the interface

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "params": {"name": "TiO2-Pt interface relax"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "params": {
    "workflow_id": "<wf_id>",
    "task_type": "geo_opt",
    "params": {"software": "vasp", "ENCUT": 520,
               "system_name": "TiO2-Pt interface"}
  }
}}
```

## Tolerance Guidelines

| Mismatch Level | Tolerance Values | Use Case |
|----------------|-----------------|----------|
| Tight | 0.03 | Epitaxial growth, accurate interfaces |
| Standard | 0.09 | General screening, most applications |
| Loose | 0.15 | Exploratory, when few matches found |

Tighter tolerances produce fewer but higher-quality matches. Loosen
tolerances if no matches are found, or increase `max_area`.

## Common Pitfalls

1. Both substrate and film must be **bulk** crystals (not slabs). The
   builder cuts slabs internally based on the Miller indices you specify.
2. Large `max_area` values (> 500 A^2) can produce structures with
   thousands of atoms. Start small and increase if needed.
3. The `gap` parameter controls the initial interface distance before
   relaxation. Too small (< 1.5 A) causes atomic overlap; too large
   (> 4 A) may not capture interface bonding.
4. Always relax the interface with DFT. The as-built structure has ideal
   geometry that does not reflect real interface reconstruction.
5. For oxide/metal interfaces, use DFT+U on the oxide side. The metal
   does not need U corrections.
6. Van der Waals corrections (DFT-D3) are important for weakly bonded
   interfaces (2D/2D stacks, vdW heterostructures).
7. Strain from lattice mismatch is applied to the film by default. For
   large mismatches (> 5%), the film may be significantly distorted.
   Consider if this is physically reasonable.
