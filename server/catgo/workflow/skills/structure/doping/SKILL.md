---
name: substitutional-doping
description: >
  Use when the user asks to dope a material, substitute one element for another,
  create alloy surfaces, or introduce heteroatoms into a structure.
---

# Substitutional Doping

## Overview

Substitutional doping replaces one or more host atoms with dopant atoms.
Common applications:

- **Catalyst tuning**: Fe-doped NiOOH for OER, N-doped graphene for ORR
- **Alloy surfaces**: PtRu, PtNi, CuZn for selectivity control
- **Band engineering**: Al-doped ZnO, Nb-doped TiO2
- **Single-atom catalysts**: isolated Pt in CeO2, Fe in N-doped carbon

## MCP Tool: catgo_structure(action: replace_atom)

### Replace a single atom

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace_atom",
  "atom_index": 5,
  "new_element": "Co"
}}
```

This replaces atom #5 (0-based index) with Co, keeping the same position.

### Identify which atom to replace

First, inspect the structure to find the target atom:

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

The response lists all atoms with indices, elements, and positions.
Select the atom index based on:
- Element type (replace Ni with Co)
- Position (surface vs bulk, specific layer)

### Replace multiple atoms (alloy)

For a Pt3Ni(111) alloy slab, replace every 4th Pt with Ni:

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace_atom", "atom_index": 3, "new_element": "Ni"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace_atom", "atom_index": 7, "new_element": "Ni"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace_atom", "atom_index": 11, "new_element": "Ni"
}}
```

### Verify after doping

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Check: correct composition, dopant in expected position, no structural
distortion (will be resolved by geo_opt).

## Complete Doping Workflow: Fe-doped NiOOH for OER

### Step 1: Fetch and build host structure

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "NiOOH", "source": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [0, 0, 1],
  "min_slab_size": 12.0, "min_vacuum_size": 15.0
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell", "scaling": [2, 2, 1]
}}
```

### Step 2: Replace one Ni with Fe

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Identify a surface Ni atom (e.g., atom_index=8):

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace_atom", "atom_index": 8, "new_element": "Fe"
}}
```

### Step 3: Relax doped structure

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "Fe-doped NiOOH OER"
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_doped",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520,
             "system_name": "Fe-NiOOH relaxation"}
}}
```

## Python API

```python
from catgo.workflow import Workflow
import json

# Load and modify structure
with open("niooh_slab.json") as f:
    structure = json.load(f)

# Replace atom in structure dict before workflow
# (Index 8 is a surface Ni atom)
structure["sites"][8]["species"][0]["element"] = "Fe"

wf = Workflow("Fe-doped NiOOH")

inp = wf.add_task("structure_input", structure=json.dumps(structure))
opt = wf.add_task("geo_opt",
    structure=inp.output.structure,
    software="vasp", ENCUT=520, ISPIN=2)

wf.submit()
```

## Doping Strategies

### Surface Doping

Replace atoms in the top 1-2 layers. These directly interact with
adsorbates and affect catalytic properties.

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Surface atoms have the highest z-coordinates. Replace those.

### Subsurface Doping

Replace atoms in the 2nd or 3rd layer. This modifies the electronic
structure of surface atoms (ligand effect) without directly
participating in bonding.

### Random Alloy

For a random A_x B_(1-x) alloy, replace atoms randomly to match
the desired composition. For a 2x2x1 slab with 16 metal atoms:

| Composition | Atoms to Replace |
|------------|-----------------|
| Pt3Ni (25% Ni) | 4 of 16 |
| PtNi (50% Ni) | 8 of 16 |
| PtNi3 (75% Ni) | 12 of 16 |

### Ordered Alloy

For L1_0 or L1_2 ordered alloys, replace atoms in a specific pattern.
Use `catgo_view` to identify the sublattice positions.

## Magnetic Considerations

Many dopants (Fe, Co, Ni, Mn, Cr) are magnetic. Enable spin polarization:

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "workflow_id": "wf_doped",
  "task_type": "geo_opt",
  "params": {
    "software": "vasp", "ENCUT": 520,
    "ISPIN": 2,
    "MAGMOM": "16*0.6 1*5.0 24*0.6",
    "system_name": "spin-polarized Fe-NiOOH"
  }
}}
```

Set initial MAGMOM high for the dopant atom (e.g., 5.0 for Fe) and
low for the host (e.g., 0.6 for Ni in NiOOH).

## DFT+U for Transition Metal Dopants

Localized d-electrons in dopants often require Hubbard U correction:

| Dopant | Typical U (eV) | Host Systems |
|--------|---------------|-------------|
| Fe (3d) | 4.0-5.3 | Oxides, oxyhydroxides |
| Co (3d) | 3.3-3.5 | Oxides |
| Ni (3d) | 6.0-6.4 | NiO, NiOOH |
| Mn (3d) | 3.9-4.0 | MnO2, perovskites |
| Ti (3d) | 3.0-4.0 | TiO2 |

Add U parameters via LDAU settings in VASP task params.

## Common Pitfalls

1. Always relax (geo_opt) after doping. The dopant has a different atomic
   radius, so the local structure will distort.
2. For charged dopants (e.g., Al3+ replacing Si4+), the system may need
   charge compensation. Consider adding/removing atoms or using a
   charged cell (not recommended for slabs).
3. Doping changes atom indices. If you plan to place adsorbates after
   doping, re-check atom positions with `catgo_view`.
4. For transition metal dopants in oxides, always use ISPIN=2 and
   consider DFT+U. Non-magnetic calculations may converge to wrong
   electronic ground states.
5. When comparing doped vs undoped systems, use the same supercell size,
   k-points, and ENCUT. The doped cell should only differ by the
   substituted atom.
6. For single-atom catalysts (SAC), use a large supercell (3x3 or 4x4)
   to minimize dopant-dopant periodic interactions.
