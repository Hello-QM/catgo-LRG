---
name: structure-builder
description: >
  Use when the user asks to load, fetch, build, modify, or transform crystal/molecular
  structures. Covers database import, supercell, defects, doping, intercalation, nanotubes,
  and atom-level editing.
---

# Structure Builder

## Loading Structures

### From Online Databases
- `catgo_fetch_crystal` — Load crystal by formula or structure_id from OPTIMADE providers
  (`mp`=Materials Project, `mc3d`, `alexandria`, `twodmatpedia`, `omdb`)
- `catgo_search_crystals` — Search and list multiple matches. Use this first when browsing,
  then `catgo_fetch_crystal` with a specific `structure_id`.
- `catgo_fetch_molecule` — Fetch molecules from PubChem by name, formula, or SMILES.

**Provider heuristics**:
- General inorganic crystals: `mp` (largest database)
- 2D materials: `twodmatpedia`
- Organic molecules: use `catgo_fetch_molecule`, not OPTIMADE

### From Current Viewer
Call `catgo_structure_info` to inspect the loaded structure. A tool whose input is named
`structure` auto-fetches the current viewer structure — no need to pass a structure dict.

Tools that take **two** geometries name them explicitly and cannot be auto-filled (there is
no way to know which operand the viewer holds): `catgo_passivate` (`slab`, `bulk`),
`catgo_hetero_search` / `catgo_hetero_build` (`substrate`, `film`),
`catgo_hetero_search_lateral` / `catgo_hetero_build_lateral` (`slab_A`, `slab_B`),
`catgo_merge` (`base`, `incoming`). Fetch with `catgo_structure_info` and pass them yourself.

### The result is on screen
Whatever a builder returns is pushed into the 3D viewer as it runs — slabs, defects, doping,
substitution, intercalation, adsorbate placement, passivation, heterostructures, nanotubes,
moiré cells, reticular frameworks, optimized geometries. Report what changed in one sentence;
do not re-describe coordinates the user is looking at, and do not claim it cannot be shown.

## Atom-Level Operations

| Tool | Use When |
|------|----------|
| `catgo_add_atom` / `catgo_add_atoms` | Adding atoms at Cartesian positions (Angstroms) |
| `catgo_delete_atoms` | Removing atoms by 0-based index |
| `catgo_replace_atom` | Changing element at a site |
| `catgo_move_atom` / `catgo_move_atoms` | Repositioning atoms |

## Lattice and Cell Operations

| Tool | Use When |
|------|----------|
| `catgo_supercell` | Expanding unit cell by [na, nb, nc] or 3x3 matrix |
| `catgo_set_lattice` | Adding/changing periodic cell (wraps molecules in a box) |
| `catgo_merge` | Combining two structures at a given position |

## Defect Engineering

| Tool | Use When |
|------|----------|
| `catgo_build_defect` | Point defects: vacancy, substitution, interstitial |
| `catgo_doping` | Substitutional doping (replace host with dopant) |
| `catgo_substitution` | Combinatorial multi-site substitution |
| `catgo_intercalation` | Insert species (Li, Na) into layered structures |
| `catgo_build_strain` | Apply strain/deformation (Voigt notation or 3x3 matrix) |

## Nanostructures

| Tool | Use When |
|------|----------|
| `catgo_nanotube_build` | Carbon or BN nanotubes from chiral indices (n, m) |
| `catgo_nanotube_info` | Compute nanotube geometry before building |

## Common Recipes

### Doped supercell
1. `catgo_fetch_crystal` → 2. `catgo_supercell` → 3. `catgo_doping` → 4. `catgo_structure_info`

### Defective structure for DFT
1. Fetch bulk → 2. `catgo_supercell` (large enough to avoid defect-defect interaction) →
3. `catgo_build_defect` → 4. `catgo_structure_info`

### Intercalated battery material
1. `catgo_fetch_crystal` (e.g. MoS2) → 2. `catgo_intercalation` (species="Li") → 3. Verify
