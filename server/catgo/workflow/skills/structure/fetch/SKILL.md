---
name: structure-fetch
description: Fetch crystal structures from Materials Project/OPTIMADE databases and molecules from PubChem. Search, select, and load structures into the CatGO viewer.
---

# Structure Fetching Skill

## When to Use

Use this skill when the user wants to:
- Load a known crystal structure (e.g., "get TiO2 rutile")
- Search for materials by composition or elements
- Fetch a molecule by name or formula from PubChem
- Browse structures from OPTIMADE-compliant databases

## Data Sources

| Source | Tool action | What it has |
|---|---|---|
| Materials Project | `catgo_fetch(action: "crystal")` | ~150k inorganic crystals, DFT-relaxed |
| Alexandria | `catgo_fetch(action: "search", provider: "alexandria")` | ~5M structures, PBE/PBEsol |
| MC3D | `catgo_fetch(action: "search", provider: "mc3d")` | Curated crystal database |
| 2DMatPedia | `catgo_fetch(action: "search", provider: "twodmatpedia")` | 2D materials |
| PubChem | `catgo_fetch(action: "molecule")` | ~110M molecules, 3D conformers |

## MCP Tool Examples

### Fetch a crystal by formula (Materials Project)

```json
catgo_fetch(action: "crystal", formula: "TiO2", provider: "mp")
```

This loads the lowest-energy TiO2 structure from Materials Project directly
into the viewer. The formula is automatically normalized for OPTIMADE
(alphabetical element order: "O2Ti").

### Fetch a specific structure by ID

```json
catgo_fetch(action: "crystal", structure_id: "mp-2657", provider: "mp")
```

### Search for structures (returns list, does not auto-load)

```json
catgo_fetch(action: "search", formula: "Fe2O3", provider: "mp", limit: 10)
```

Returns a list of matching structures with IDs, space groups, and energies.
The user then picks one to load:

```json
catgo_fetch(action: "crystal", structure_id: "mp-19770", provider: "mp")
```

### Search by elements (any compound containing these elements)

```json
catgo_fetch(action: "search", elements: ["Ti", "O"], provider: "mp", limit: 5)
```

This finds all compounds containing Ti and O (TiO2, Ti2O3, SrTiO3, etc.).

### Search across multiple providers

```json
catgo_fetch(action: "search", formula: "BaTiO3", provider: "alexandria", limit: 5)
```

### Fetch a molecule from PubChem

By name:

```json
catgo_fetch(action: "molecule", query: "aspirin")
```

By formula:

```json
catgo_fetch(action: "molecule", query: "C6H12O6")
```

By PubChem CID:

```json
catgo_fetch(action: "molecule", cid: 2244)
```

### Add a molecule to existing structure

To add a molecule into the current structure (e.g., adding an adsorbate
above a surface), use `catgo_structure` instead:

```json
catgo_structure(action: "add_molecule", query: "water", count: 1)
```

This fetches from PubChem and merges into the current viewer structure.
For multiple copies (e.g., a water layer):

```json
catgo_structure(action: "add_molecule", query: "water", count: 5, spacing: 2.8)
```

## Workflow: Search -> Select -> Load -> Build

A typical session for setting up a catalysis calculation:

1. Search for the bulk crystal:
```json
catgo_fetch(action: "search", formula: "RuO2", provider: "mp", limit: 5)
```

2. Load the desired polymorph:
```json
catgo_fetch(action: "crystal", structure_id: "mp-825", provider: "mp")
```

3. Verify it loaded correctly:
```json
catgo_view(action: "get_state")
```

4. Build a slab for surface chemistry:
```json
catgo_structure(action: "slab", miller_index: [1, 1, 0],
                min_slab_size: 10.0, min_vacuum_size: 15.0)
```

5. Place an adsorbate:
```json
catgo_structure(action: "add_molecule", query: "OH")
```

## Formula Normalization

OPTIMADE requires formulas in alphabetical element order:
- User says "TiO2" -> query sends "O2Ti"
- User says "Fe2O3" -> query sends "Fe2O3" (already alphabetical)
- User says "H2O" -> query sends "H2O" (already alphabetical)

Unicode subscripts are automatically converted: TiO₂ -> TiO2.

The `catgo_fetch` tool handles this normalization internally. You do not
need to manually reorder formulas.

## Provider-Specific Notes

### Materials Project (mp)
- Highest quality: structures are DFT-relaxed with standardized settings
- Has computed properties: band gap, formation energy, stability
- Preferred for common inorganic materials

### Alexandria
- Largest database (~5M structures)
- Good for finding exotic compositions
- PBE and PBEsol relaxed

### PubChem
- Molecules only (no periodic structures)
- 3D conformers from MMFF94 or experimental data
- Returns the first conformer; may not be the global minimum
- Always optimize the geometry after fetching for DFT work

## Common Mistakes

- Searching with non-alphabetical formula on OPTIMADE (handled automatically)
- Expecting PubChem molecules to be DFT-optimized (they are not)
- Loading a crystal when a molecule is needed, or vice versa
- Not checking `catgo_view(action: "get_state")` after loading to confirm
  the structure is correct
