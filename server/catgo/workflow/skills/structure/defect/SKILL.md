---
name: defect-generation
description: >
  Use when the user asks to create point defects such as vacancies,
  substitutional defects, or interstitial atoms in a crystal structure.
tags: [structure, defect, vacancy, substitution, interstitial]
---

# Defect Generation

## Overview

Point defect generation creates vacancy, substitution, or interstitial
defects in periodic structures. This is essential for studying:

- **Vacancy formation energies**: Removing atoms to find stable vacancy sites
- **Substitutional defects**: Replacing host atoms (e.g., N replacing O in TiO2)
- **Interstitial defects**: Inserting atoms in interstitial positions
- **Defect-mediated catalysis**: Active sites at vacancy or dopant locations

The tool optionally builds a supercell before creating the defect to
minimize periodic image interactions.

## MCP Tool: catgo_structure (via REST /build/defect)

Defect generation is available through the `/build/defect` endpoint. In the
full MCP server, use the `catgo_build_defect` tool. The structure is
automatically fetched from the viewer.

### Create a Vacancy

Remove an atom at a specific site index:

```json
{"tool": "catgo_structure", "arguments": {
  "action": "delete",
  "indices": [5]
}}
```

For a workflow-integrated vacancy with supercell expansion, use the REST
endpoint directly:

```json
POST /build/defect
{
  "structure": { ... },
  "defect_type": "vacancy",
  "site_index": 5,
  "supercell": "2x2x2"
}
```

### Create All Symmetry-Unique Vacancies

Set `site_index` to -1 to generate one vacancy structure per symmetry-unique
site. This is useful for screening which vacancy site is most stable:

```json
POST /build/defect
{
  "structure": { ... },
  "defect_type": "vacancy",
  "site_index": -1,
  "supercell": "2x2x2"
}
```

Returns multiple structures, each with a different symmetry-unique atom
removed.

### Create a Substitutional Defect

Replace one atom with a different element:

```json
POST /build/defect
{
  "structure": { ... },
  "defect_type": "substitution",
  "site_index": 3,
  "substitute_element": "Fe",
  "supercell": "2x2x2"
}
```

Or use the viewer-based approach:

```json
{"tool": "catgo_structure", "arguments": {
  "action": "replace",
  "index": 3,
  "new_element": "Fe"
}}
```

### Create an Interstitial Defect

Insert an atom near a reference site. The interstitial is placed at the
midpoint between the reference site and its nearest neighbor:

```json
POST /build/defect
{
  "structure": { ... },
  "defect_type": "interstitial",
  "site_index": 0,
  "substitute_element": "Li",
  "supercell": "2x2x2"
}
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| defect_type | string | "vacancy" | Type: `vacancy`, `substitution`, `interstitial` |
| site_index | int | 0 | Atom index to act on (-1 for all unique vacancies) |
| substitute_element | string | "" | Element for substitution/interstitial |
| supercell | string | "2x2x2" | Supercell scaling before defect creation |
| structure | dict | -- | Structure in pymatgen dict format |

## Complete Workflow: Vacancy Formation Energy

### 1. Fetch and prepare structure

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "TiO2", "provider": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell", "scaling": [2, 2, 2]
}}
```

### 2. Identify target atom

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Find an O atom (e.g., index 12) to create an oxygen vacancy.

### 3. Create vacancy

```json
{"tool": "catgo_structure", "arguments": {
  "action": "delete", "indices": [12]
}}
```

### 4. Set up DFT workflow

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "create", "name": "O vacancy in TiO2"
}}
```

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_vac",
  "node_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "ISPIN": 2,
             "system_name": "TiO2 O-vacancy"}
}}
```

### 5. Compute vacancy formation energy

```
E_f(V_O) = E(TiO2 - O) - E(TiO2_perfect) + 0.5 * E(O2)
```

Run the same geo_opt for the perfect supercell and gas-phase O2 as
references.

## Common Pitfalls

1. Always use a supercell large enough (at least 2x2x2 for bulk, 3x3x1
   for surfaces) to minimize defect-defect interactions across periodic
   boundaries.
2. Vacancies in transition-metal oxides often require spin polarization
   (`ISPIN=2`) and DFT+U corrections for accurate formation energies.
3. After creating a defect, always relax the structure with geo_opt.
   The atoms neighboring the defect will move significantly.
4. For charged defects (e.g., V_O^{2+} in TiO2), additional corrections
   (Freysoldt, Kumagai) are needed for finite-size effects.
5. The `site_index` uses 0-based indexing. Use `catgo_view` to verify
   which atom you are removing before proceeding.
