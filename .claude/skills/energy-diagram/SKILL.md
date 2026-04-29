---
name: energy-diagram
description: >
  Use when the user asks to generate a reaction energy diagram, free energy
  profile, potential energy surface plot, or pathway comparison diagram
  for catalysis or reaction mechanism studies.
tags: [analysis, catalysis, energy-diagram, free-energy, pathway, Plotly]
---

# Energy Diagram Generation

## Overview

Generates Plotly-compatible reaction energy pathway diagrams from computed
intermediate and transition-state energies. The output includes horizontal
line segments for intermediates, cubic-spline curves for transition states,
and dashed connectors between consecutive steps.

Key applications:
- **Reaction mechanism comparison**: Overlay multiple pathways on one diagram
- **Catalysis studies**: Visualize OER, HER, CO2RR, NRR free energy profiles
- **Transition state analysis**: Show activation barriers as TS arches
- **Publication figures**: Export as SVG/PNG from the Plotly viewer

## MCP Tool: catgo_catalysis_energy_diagram

In the full MCP server, use the `catgo_catalysis_energy_diagram` tool. In
the workflow engine, the `free_energy` node generates energy diagrams
automatically from upstream `gibbs_energy` nodes.

### Generate a Simple Energy Diagram

```json
{"tool": "catgo_catalysis_energy_diagram", "arguments": {
  "pathways": [
    {
      "name": "OER on RuO2(110)",
      "color": "#1f77b4",
      "steps": [
        {"label": "*", "energy": 0.0},
        {"label": "*OH", "energy": 0.85},
        {"label": "*O", "energy": 1.60},
        {"label": "*OOH", "energy": 3.20},
        {"label": "O2", "energy": 4.92}
      ]
    }
  ]
}}
```

### Compare Multiple Pathways

```json
{"tool": "catgo_catalysis_energy_diagram", "arguments": {
  "pathways": [
    {
      "name": "RuO2(110)",
      "color": "#1f77b4",
      "steps": [
        {"label": "*", "energy": 0.0},
        {"label": "*OH", "energy": 0.85},
        {"label": "*O", "energy": 1.60},
        {"label": "*OOH", "energy": 3.20},
        {"label": "O2", "energy": 4.92}
      ]
    },
    {
      "name": "IrO2(110)",
      "color": "#ff7f0e",
      "steps": [
        {"label": "*", "energy": 0.0},
        {"label": "*OH", "energy": 1.05},
        {"label": "*O", "energy": 1.95},
        {"label": "*OOH", "energy": 3.45},
        {"label": "O2", "energy": 4.92}
      ]
    }
  ]
}}
```

### Include Transition States

Mark transition states with `"is_ts": true`. These appear as cubic-spline
arches between the adjacent intermediates:

```json
{"tool": "catgo_catalysis_energy_diagram", "arguments": {
  "pathways": [
    {
      "name": "CO oxidation on Pt(111)",
      "color": "#2ca02c",
      "steps": [
        {"label": "CO* + O*", "energy": 0.0},
        {"label": "TS", "energy": 0.85, "is_ts": true},
        {"label": "CO2(g)", "energy": -1.20}
      ]
    }
  ]
}}
```

### Custom Layout Configuration

```json
{"tool": "catgo_catalysis_energy_diagram", "arguments": {
  "pathways": [ ... ],
  "config": {
    "height": 500,
    "y_label": "Gibbs Free Energy (eV)",
    "x_label": "Reaction Coordinate",
    "energy_format": ".3f",
    "line_width": 4
  }
}}
```

## Parameters

### pathways (required)

Array of pathway objects. Each pathway contains:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | no | Legend label for this pathway |
| color | string | no | Line color (CSS color, e.g., `"#1f77b4"`) |
| steps | list[dict] | yes | Ordered list of intermediates and TSs |

Each step dict:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| label | string | yes | State label (e.g., "*OH", "TS1") |
| energy | float | yes | Energy in eV |
| is_ts | bool | no | True for transition states (default false) |

### config (optional)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| base_spacing | float | 1.0 | Base horizontal spacing between states |
| hline_ratio | float | 0.3 | Width of horizontal energy lines |
| ts_spacing_ratio | float | 0.4 | Width of TS spline curves |
| vline_ratio | float | 0.3 | Width of dashed connectors |
| line_width | float | 3 | Line thickness |
| energy_format | string | ".2f" | Python format string for energy labels |
| height | int | 450 | Plot height in pixels |
| y_label | string | "Free Energy (eV)" | Y-axis title |
| x_label | string | "Reaction Coordinate" | X-axis title |

## Return Format

```json
{
  "traces": [ ... ],
  "layout": { ... },
  "annotations": [ ... ]
}
```

The return value is directly compatible with Plotly: pass `traces` as the
data array, merge `annotations` into `layout.annotations`, and render with
`Plotly.newPlot(div, traces, layout)`.

## Workflow Integration: free_energy Node

In the CatGo workflow engine, the `free_energy` node automatically
generates an energy diagram from upstream `gibbs_energy` nodes:

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "batch",
  "workflow_id": "wf_oer",
  "operations": [
    {"op": "add_node", "node_type": "free_energy", "label": "diagram",
     "params": {"input_mode": "auto"}},
    {"op": "connect", "from_id": "gibbs_oh", "to_id": "diagram",
     "from_handle": "gibbs", "to_handle": "gibbs"},
    {"op": "connect", "from_id": "gibbs_o", "to_id": "diagram",
     "from_handle": "gibbs", "to_handle": "gibbs"},
    {"op": "connect", "from_id": "gibbs_ooh", "to_id": "diagram",
     "from_handle": "gibbs", "to_handle": "gibbs"}
  ]
}}
```

The `free_energy` node collects Gibbs energies from all connected upstream
nodes and arranges them into a pathway diagram automatically.

## Important: Use Gibbs Free Energies, NOT DFT Energies

All energy values passed to this tool **must be Gibbs free energies** (G), not
raw DFT electronic energies (E_DFT). Each intermediate and gas-phase reference
must go through the full chain: geo_opt --> freq --> gibbs_energy.

```
G = E_DFT + ZPE - TS
```

Using raw E_DFT omits zero-point energy (ZPE) and entropy (TS), which contribute
0.2-0.5 eV per intermediate. This makes the resulting diagram quantitatively
wrong and can change which step is potential-determining.

For electrochemical reactions (OER, HER, CO2RR, NRR), also apply:
- **Atom balancing** with gas-phase references (H2, H2O, CO2, N2, NH3)
- **pH correction**: subtract 0.059 * pH eV per proton-transfer step at 298 K

## Common Pitfalls

1. Transition-state steps (`is_ts: true`) must be placed between two
   non-TS steps in the pathway. A TS at the start or end of a pathway
   will cause errors because the spline needs adjacent energy values.
2. Energies should be Gibbs free energies in eV, referenced to a common
   zero (typically the clean slab + gas-phase references).
3. When comparing pathways, use the same energy reference for all of
   them. Shifting one pathway by a constant offset invalidates the
   comparison.
4. The anti-overlap algorithm adjusts annotation positions when
   multiple pathways have states at the same x-coordinate. For heavily
   overlapping pathways, increase `base_spacing` in the config.
5. The returned traces use null-gap separation for disconnected
   line segments. This is a standard Plotly pattern for drawing
   multiple segments in one trace.
