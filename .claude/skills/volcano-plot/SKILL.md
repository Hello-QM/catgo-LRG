---
name: volcano-plot
description: >
  Use when the user asks about volcano plots, catalyst screening,
  activity descriptors, Sabatier principle, or comparing catalyst
  performance across a descriptor space.
tags: [analysis, catalysis, volcano, screening, descriptor]
---

# Volcano Plot Generation

## Overview

Volcano plots visualize the Sabatier principle: plotting catalytic activity
(negative overpotential) against a binding energy descriptor to identify
optimal catalysts at the peak of the volcano. This is the standard tool
for computational catalyst screening.

Key applications:
- **OER/HER/ORR catalyst screening**: Compare overpotentials across catalyst compositions
- **Scaling relation validation**: Overlay theoretical volcano lines from Norskov scaling
- **Descriptor identification**: Find which adsorption energy best predicts activity
- **High-throughput screening**: Visualize hundreds of candidates in one plot

## MCP Tool: catgo_catalysis action="volcano"

### Generate Volcano Plot Data

Provide a list of catalyst results with descriptor values and overpotentials:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "volcano",
  "params": {
    "catalyst_results": [
      {"name": "RuO2(110)", "dG_OH": 1.45, "overpotential": 0.37},
      {"name": "IrO2(110)", "dG_OH": 1.52, "overpotential": 0.42},
      {"name": "MnO2(110)", "dG_OH": 0.95, "overpotential": 0.68},
      {"name": "TiO2(110)", "dG_OH": 2.10, "overpotential": 1.15},
      {"name": "Fe-NiOOH", "dG_OH": 1.30, "overpotential": 0.32}
    ],
    "reaction": "OER",
    "descriptor_x": "dG_OH"
  }
}}
```

### Custom Descriptor Axes

Use any computed property as the x-axis descriptor:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "volcano",
  "params": {
    "catalyst_results": [
      {"name": "Pt(111)", "d_band_center": -2.25, "overpotential": 0.45},
      {"name": "Pd(111)", "d_band_center": -1.83, "overpotential": 0.52},
      {"name": "Ni(111)", "d_band_center": -1.29, "overpotential": 0.75}
    ],
    "reaction": "HER",
    "descriptor_x": "d_band_center"
  }
}}
```

### Two-Descriptor Plot

Specify both x and y descriptors explicitly (instead of using
overpotential for y):

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "volcano",
  "params": {
    "catalyst_results": [
      {"name": "RuO2", "dG_OH": 1.45, "dG_O": 2.90},
      {"name": "IrO2", "dG_OH": 1.52, "dG_O": 3.10}
    ],
    "reaction": "OER",
    "descriptor_x": "dG_OH",
    "descriptor_y": "dG_O"
  }
}}
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| catalyst_results | list[dict] | -- | List of catalyst dicts with name, descriptor values, overpotential |
| reaction | string | "OER" | Reaction type: `OER`, `HER`, `CO2RR`, `NRR` |
| descriptor_x | string | "dG_OH" | Key for x-axis descriptor in result dicts |
| descriptor_y | string | null | Key for y-axis. If null, uses -overpotential |

### Catalyst Result Dict Fields

Each dict in `catalyst_results` should contain:

| Field | Required | Description |
|-------|----------|-------------|
| name | yes | Catalyst identifier (plot label) |
| (descriptor_x key) | yes | X-axis value (e.g., dG_OH, d_band_center) |
| overpotential | yes* | Overpotential in V (*unless descriptor_y is set) |

## Return Format

```json
{
  "points": [
    {"name": "RuO2(110)", "x": 1.45, "y": -0.37, "dG_OH": 1.45, "overpotential": 0.37}
  ],
  "ideal_line": {
    "x": [0.5, 0.505, ...],
    "y": [-0.23, -0.22, ...]
  },
  "descriptor_x": "dG_OH",
  "reaction": "OER"
}
```

The `ideal_line` is generated for OER using Norskov scaling relations:
- Left branch: limited by OH adsorption (step 1)
- Right branch: limited by OOH formation (step 4), using the scaling
  relation dG_OOH = 0.84 * dG_OH + 3.29

For other reactions, `ideal_line` is null (scaling relations not
hard-coded).

## Complete Workflow: OER Catalyst Screening

### 1. Compute overpotentials for each candidate

For each catalyst surface, run the full OER workflow (see OER skill) to
obtain dG_OH, dG_O, dG_OOH, and the overpotential.

### 2. Collect results

Gather the results from all candidates into a list:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "oer",
  "params": {"dG_OH": 1.45, "dG_O": 2.90, "dG_OOH": 3.74}
}}
```

Repeat for each catalyst.

### 3. Generate volcano plot

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "volcano",
  "params": {
    "catalyst_results": [
      {"name": "RuO2", "dG_OH": 1.45, "overpotential": 0.37},
      {"name": "IrO2", "dG_OH": 1.52, "overpotential": 0.42}
    ],
    "reaction": "OER",
    "descriptor_x": "dG_OH"
  }
}}
```

## Common Pitfalls

1. All descriptor values must use consistent DFT settings (same
   functional, ENCUT, k-points). Mixing PBE and RPBE results on one
   volcano plot produces misleading comparisons.
2. The OER ideal volcano line assumes the universal OOH-OH scaling
   relation (dG_OOH = 0.84 * dG_OH + 3.29). This may not hold for
   non-oxide catalysts.
3. The y-axis convention is -overpotential (higher = better catalyst).
   A catalyst at the peak of the volcano has the lowest overpotential.
4. Catalyst results missing the descriptor_x key are silently skipped.
   Check that all result dicts have the expected keys.
5. For HER, the typical descriptor is dG_H (hydrogen binding energy).
   For CO2RR, dG_CO or dG_COOH is commonly used.
