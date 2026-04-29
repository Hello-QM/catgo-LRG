---
name: intercalation
description: >
  Use when the user asks to intercalate atoms or ions between layers,
  insert lithium into a cathode, or place species in interlayer gaps
  of a layered material.
---

# Intercalation

## Overview

Intercalation inserts guest atoms or ions into the interlayer spaces of
a layered host material. This is fundamental to battery electrode design,
where ions shuttle between electrodes during charge/discharge cycles.

Common applications:

- **Li-ion batteries**: Li intercalation in LiCoO2, LiFePO4, graphite
- **Na-ion batteries**: Na intercalation in layered oxides, MXenes
- **Supercapacitors**: ion insertion in MXenes, layered hydroxides
- **Catalysis**: intercalated species modifying interlayer chemistry
- **2D materials**: ion intercalation in MoS2, graphite for exfoliation

## MCP Tool: catgo_intercalation

```json
{"tool": "catgo_intercalation", "arguments": {
  "structure": "<current structure dict>",
  "species": "Li",
  "position": "auto",
  "n_intercalants": 1
}}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `structure` | Layered host structure dict | (required) |
| `species` | Intercalant element symbol | (required) |
| `position` | Placement strategy | "auto" |
| `n_intercalants` | Number of intercalant atoms to insert | 1 |

### Position Modes

| Mode | Description |
|------|-------------|
| `auto` | Finds the largest gap in z-fractional coordinates and inserts at the midpoint. Best default for layered materials. |
| `tetrahedral` | Places at approximate tetrahedral interstitial sites (frac coords ~0.25). |
| `octahedral` | Places at approximate octahedral interstitial sites (frac coords ~0.5). |
| `custom` | For manual positioning (specify coordinates separately). |

### Router: `/build/intercalation` (POST)

## Complete Workflow: Li Intercalation in LiCoO2

### Step 1: Fetch the host structure

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "CoO2", "source": "mp"
}}
```

Or fetch the fully lithiated phase:

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "LiCoO2", "source": "mp"
}}
```

### Step 2: Create a supercell for dilute intercalation

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell",
  "scaling": [2, 2, 1]
}}
```

### Step 3: Intercalate Li

```json
{"tool": "catgo_intercalation", "arguments": {
  "species": "Li",
  "position": "auto",
  "n_intercalants": 1
}}
```

For higher concentrations, increase `n_intercalants`. Multiple
intercalants are distributed across the interlayer plane.

### Step 4: Verify

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Check: Li atom is between layers, not overlapping with host atoms,
reasonable interlayer distance preserved.

### Step 5: Relax and compute intercalation voltage

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "params": {"name": "Li-CoO2 intercalation"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "params": {
    "workflow_id": "<wf_id>",
    "task_type": "geo_opt",
    "params": {"software": "vasp", "ENCUT": 520,
               "LDAU": true, "LDAUU": {"Co": 3.32},
               "system_name": "LixCoO2 relax"}
  }
}}
```

## Intercalation Voltage Calculation

The average intercalation voltage is:

```
V = -(E[Li_x2 Host] - E[Li_x1 Host] - (x2 - x1) * E[Li_metal]) / ((x2 - x1) * F)
```

where F is the Faraday constant. In practice:

1. Relax the empty host (x = 0)
2. Relax the fully intercalated structure (x = 1)
3. Optionally relax intermediate compositions
4. Compute V from the energy difference

## Common Intercalant Species

| Species | Application | Typical Hosts |
|---------|-------------|--------------|
| Li | Li-ion batteries | CoO2, FePO4, MnO2, graphite, TiS2 |
| Na | Na-ion batteries | MnO2, V2O5, Prussian blue analogues |
| K | K-ion batteries | Graphite, MoS2 |
| Mg | Mg batteries | V2O5, MoS2, TiS2 |
| H | Proton intercalation | MnO2, WO3 (electrochromics) |

## DFT Considerations

- **DFT+U**: Required for transition metal oxides (Co, Mn, Fe, Ni).
  Common U values: Co (3.32 eV), Mn (3.9 eV), Fe (5.3 eV), Ni (6.2 eV).
- **Van der Waals**: DFT-D3 corrections important for layered materials
  where interlayer bonding is weak.
- **Spin polarization**: Always use ISPIN=2 for transition metal oxides.
- **K-points**: Sufficient sampling in the layer plane; fewer points
  needed perpendicular to layers.

## Common Pitfalls

1. The `auto` position mode finds the largest z-gap. For materials with
   multiple interlayer gaps of similar size, verify the intercalant
   ended up in the correct gap.
2. Always relax after intercalation. The host lattice expands to
   accommodate the guest species.
3. For concentrated intercalation (multiple atoms), ensure intercalants
   are not placed too close together. Check with `catgo_view` after
   insertion.
4. The host structure should be a bulk layered material, not a slab.
   Slabs have vacuum that will confuse the auto-positioning algorithm.
5. Transition metal oxidation states change upon intercalation (e.g.,
   Co4+ to Co3+ when Li is inserted). This affects magnetic moments
   and DFT+U parameters.
6. For accurate voltage predictions, use the same ENCUT, k-points, and
   DFT+U parameters for all compositions in the voltage calculation.
