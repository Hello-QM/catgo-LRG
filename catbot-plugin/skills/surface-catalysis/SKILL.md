---
name: surface-catalysis
description: >
  Use when the user asks about surface slabs, Miller indices, adsorbate placement,
  adsorption sites, water layers, passivation, heterostructures, lattice matching,
  moire bilayers, or catalysis workflows.
---

# Surface & Catalysis Workflow

## Surface Slab Generation

1. Start with a bulk crystal (fetch or use current)
2. `catgo_generate_slab` with `miller_index` as [h, k, l]
   - Defaults: `min_slab_size=10.0` A, `min_vacuum_size=15.0` A
   - Returns all symmetrically distinct terminations
3. Inspect result with `catgo_structure_info`

**Miller index selection**:
| Surface | Miller Index | Common Use |
|---------|-------------|------------|
| FCC (111) | [1,1,1] | Close-packed, catalysis |
| FCC (100) | [1,0,0] | Open surface |
| BCC (110) | [1,1,0] | Close-packed |
| Rutile (110) | [1,1,0] | TiO2 catalysis |
| Perovskite (001) | [0,0,1] | ABO3 surfaces |

## Adsorbate Placement

1. `catgo_adsorption_sites` — Find top, bridge, hollow sites. `height` default 2.0 A.
2. `catgo_adsorption_place` — Place adsorbate at chosen site coordinates.

Get adsorbate molecules via `catgo_fetch_molecule`:
- CO, CO2, H2O, NH3, O2, CH4, etc.

## Surface Passivation

`catgo_passivate` — Cap dangling bonds with pseudo-hydrogen on slab bottom surface.
Requires both `slab` and `bulk` reference structure dicts.

## Water Layer

`catgo_water_layer` — Add TIP4P water layer for solid/liquid interface models.
Parameters: `z_start`, `z_end`, `min_distance` (overlap removal), `equilibrate` (optional LAMMPS).

## Heterostructure & Interface

### ZSL Lattice Matching (Two-Step)
1. `catgo_hetero_search` — Find lattice-matched substrate/film pairs
2. `catgo_hetero_build` — Build interface from selected match

### One-Step Interface
`catgo_hetero_build_intermat` — Simpler pipeline, less control but faster prototyping.

## Moire Bilayer

1. `catgo_moire_search` — Find commensurate twist angles with supercell sizes
2. `catgo_moire_build` — Build bilayer at selected angle

## Complete Catalysis Recipe

1. `catgo_fetch_crystal` (bulk, e.g. Pt)
2. `catgo_generate_slab` (miller_index=[1,1,1], min_slab_size=12, min_vacuum_size=15)
3. `catgo_passivate` (bottom surface)
4. `catgo_adsorption_sites` (find sites)
5. `catgo_fetch_molecule` (get adsorbate)
6. `catgo_adsorption_place` (place at chosen site)
7. `catgo_structure_info` (verify)
8. Generate DFT input (see computational-input skill)
