---
name: energetic-span
description: >
  Use when the user asks for the energetic span model, TOF-determining
  intermediate (TDI) or transition state (TDTS), the energetic span δE,
  the turnover frequency (TOF) of a catalytic cycle, or degree of TOF control.
tags: [analysis, catalysis, kinetics, energetic-span, TOF, homogeneous-catalysis]
---

# Energetic Span Model

## Overview

Applies the Kozuch–Shaik energetic span model to one catalytic cycle:

- **TDI / TDTS**: the intermediate and transition state that control the TOF
- **δE** = T_TDTS − I_TDI (+ ΔG_r when the TDTS comes before the TDI)
- **TOF** (exact steady-state expression) and the estimate (k_BT/h)·e^{−δE/RT}
- **Degree of TOF control** of every state (sums to 1 over TSs and over intermediates)

Use Gibbs free energies (from `geo_opt → freq → gibbs`, see the `gibbs` skill)
for physically meaningful TOFs. Raw electronic energies only give a rough δE.

## MCP Tool

Full MCP server: `catgo_catalysis_energetic_span`. Claude Code MCP server:
`catgo_catalysis` with `action: "energetic_span"` and the same arguments in
`params`. In the app, the Free Energy node's diagram editor has an
**Energetic span** tab that runs on the pathway being edited.

```json
{"tool": "catgo_catalysis_energetic_span", "arguments": {
  "steps": [
    {"label": "Cat + S",   "energy": 0.0},
    {"label": "TS1",       "energy": 0.62, "is_ts": true},
    {"label": "Int1",      "energy": -0.35},
    {"label": "TS2",       "energy": 0.48, "is_ts": true},
    {"label": "Cat + P",   "energy": -0.70}
  ],
  "temperature": 298.15,
  "unit": "eV"
}}
```

## Inputs

| Field | Default | Notes |
|---|---|---|
| steps | — | Ordered states of one turnover, `{label, energy, is_ts}`. First must be an intermediate. |
| reaction_energy | from last step | Omit when the last step is the regenerated catalyst + products. When given, all `steps` are inside the cycle. |
| temperature | 298.15 | K |
| unit | eV | `eV`, `kcal/mol` or `kJ/mol` (inputs and outputs) |

Energies are shifted so the first state is 0.

## Output

`energetic_span`, `tdi`, `tdts`, `tdts_before_tdi`, `tof`, `tof_approx` (s⁻¹),
`reaction_energy`, `states[]` (each with `degree_of_tof_control` and `role`),
`warnings`. The REST endpoint (`POST /api/workflow/catalysis/energetic-span`)
also returns `plotly_data`, the cycle diagram with TDI/TDTS marked.

## Pitfalls

- A cycle with ΔG_r ≥ 0 has no driving force: TOF ≤ 0 and a warning is returned.
- Include every relevant TS and intermediate, including off-cycle resting
  states that sit on the cycle; missing a deep intermediate underestimates δE.
- Reference: S. Kozuch, S. Shaik, *Acc. Chem. Res.* **2011**, 44, 101–110.
