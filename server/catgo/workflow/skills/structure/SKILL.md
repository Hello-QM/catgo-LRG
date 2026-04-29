---
name: structure-router
description: >
  Use when the user asks to build, modify, or prepare atomic structures:
  slabs, adsorbates, supercells, doping, defects, or fetching from databases.
---

# Structure Building Router

This skill routes structure building requests to the correct sub-skill.

## Routing Table

| User Intent | Sub-Skill | Key Indicators |
|-------------|-----------|----------------|
| Surface slab from bulk | `slab/` | "slab", "surface", "Miller index", "(111)", "(110)" |
| Place adsorbate on surface | `adsorbate/` | "adsorb", "place OH", "add CO", "binding site" |
| Substitutional doping | `doping/` | "dope", "substitute", "replace Fe with Co" |
| Fetch crystal from database | (direct) | "get from MP", "fetch TiO2", "Materials Project" |
| Fetch molecule | (direct) | "get CO molecule", "fetch water" |
| Make supercell | (direct) | "supercell", "2x2x1", "expand" |

## MCP Tools

### catgo_structure — Build and modify structures

```json
{"tool": "catgo_structure", "arguments": {"action": "slab", ...}}
{"tool": "catgo_structure", "arguments": {"action": "supercell", ...}}
{"tool": "catgo_structure", "arguments": {"action": "add_atom", ...}}
{"tool": "catgo_structure", "arguments": {"action": "delete_atoms", ...}}
{"tool": "catgo_structure", "arguments": {"action": "replace_atom", ...}}
```

### catgo_fetch — Retrieve structures from databases

```json
{"tool": "catgo_fetch", "arguments": {"action": "crystal", "formula": "TiO2", "source": "mp"}}
{"tool": "catgo_fetch", "arguments": {"action": "molecule", "name": "water"}}
```

### catgo_view — Inspect and push structures

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
{"tool": "catgo_view", "arguments": {"action": "push", "structure": {...}}}
```

## Standard Build Sequence

Most catalysis workflows follow this structure preparation pipeline:

```
1. Fetch bulk crystal      catgo_fetch(action: crystal)
2. Generate slab           catgo_structure(action: slab)
3. Make supercell          catgo_structure(action: supercell)
4. (Optional) Dope         catgo_structure(action: replace_atom)
5. Place adsorbate         catgo_structure(action: add_atom)
6. Verify structure        catgo_view(action: get_state)
```

### Example: OH on Pt(111)

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Pt", "source": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [1,1,1],
  "min_slab_size": 12.0, "min_vacuum_size": 15.0
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell", "scaling": [2, 2, 1]
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "O", "position": [2.77, 1.60, 14.5]
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "add_atom", "element": "H", "position": [2.77, 1.60, 15.47]
}}
```

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("Structure prep")

# Fetch and input
inp = wf.add_task("structure_input", structure=bulk_json)

# Build slab
slab = wf.add_task("slab_gen",
    structure=inp.output.structure,
    miller_index=[1, 1, 1],
    min_slab_size=12.0,
    min_vacuum_size=15.0)

# Place adsorbate
ads = wf.add_task("adsorbate_place",
    structure=slab.output.structure,
    adsorbate="OH",
    site_type="top",
    site_index=0)
```

## Verification Checklist

After building any structure, verify:

1. **Atom count**: expected number of atoms for the supercell size
2. **Vacuum**: sufficient vacuum for surface calculations (>12 A)
3. **No overlaps**: minimum interatomic distance > 0.5 A
4. **Correct composition**: stoichiometry matches expectation
5. **Adsorbate position**: reasonable height above surface (1.5-2.5 A)

Use `catgo_view(action: get_state)` to inspect the current structure.

## Common Pitfalls

1. Always fetch the bulk crystal BEFORE cutting a slab. Do not try to
   cut a slab from an already-cut slab.
2. Make the supercell BEFORE placing adsorbates. Supercell operation
   replicates all atoms, including adsorbates.
3. For Materials Project fetch, use reduced formula (e.g., "TiO2" not "Ti2O4").
4. After each structure modification, verify with `catgo_view` before
   proceeding to the next step.
5. The viewer shows the structure in the browser. MCP tools modify the
   viewer state directly -- there is no separate "save" step.
