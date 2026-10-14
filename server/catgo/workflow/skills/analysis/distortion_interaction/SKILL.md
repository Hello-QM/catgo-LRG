---
name: distortion-interaction
description: >
  Use when the user asks for a distortion–interaction analysis, activation
  strain model (ASM), fragment distortion/strain energy, or interaction energy
  decomposition of a transition state, complex, or points along an IRC.
tags: [analysis, kinetics, distortion-interaction, activation-strain, transition-state]
---

# Distortion–Interaction (Activation Strain) Analysis

## Overview

Decomposes the energy of a complex or transition state AB relative to its
relaxed fragments:

    ΔE_dist,X = E(X frozen at its geometry in AB) − E(X relaxed)
    ΔE_int    = E(AB) − Σ_X E(X frozen at its geometry in AB)
    ΔE        = Σ_X ΔE_dist,X + ΔE_int

Several entries (competing TSs, different catalysts, or IRC points with a
`coordinate`) are decomposed together for comparison.

## Calculations needed (per entry)

1. Optimized complex / TS (or IRC point) → `complex_energy`
2. Split it into fragments; **single point** of each fragment at its frozen
   geometry (same method, basis, charge and multiplicity per fragment) →
   `energy_in_complex`
3. Each fragment **optimized** on its own → `energy_relaxed` (usually shared
   by all entries, so pass it once in `fragment_references`)

Use the same level of theory everywhere. ORCA/Gaussian energies are in Hartree
(the default `input_unit`).

## MCP Tool

Full MCP server: `catgo_catalysis_distortion_interaction`. Claude Code MCP
server: `catgo_catalysis` with `action: "distortion_interaction"`. In the app,
the Free Energy node's diagram editor has a **Distortion–interaction** tab.

```json
{"tool": "catgo_catalysis_distortion_interaction", "arguments": {
  "entries": [
    {"label": "TS-endo", "complex_energy": -386.512340,
     "fragments": [
       {"name": "diene",       "energy_in_complex": -194.081200},
       {"name": "dienophile",  "energy_in_complex": -192.402100}
     ]},
    {"label": "TS-exo", "complex_energy": -386.510900,
     "fragments": [
       {"name": "diene",       "energy_in_complex": -194.082000},
       {"name": "dienophile",  "energy_in_complex": -192.403300}
     ]}
  ],
  "fragment_references": {"diene": -194.101500, "dienophile": -192.415200},
  "input_unit": "hartree",
  "output_unit": "kcal/mol"
}}
```

## Output

`unit` and `entries[]` with `fragments[].distortion`, `distortion`,
`interaction`, `total` (and `coordinate` when given). The REST endpoint
(`POST /api/workflow/catalysis/distortion-interaction`) also returns
`plotly_data` (grouped bars) and, when every entry has a coordinate,
`profile_plotly_data` (ASM profile along the reaction coordinate).

## References

- D. H. Ess, K. N. Houk, *J. Am. Chem. Soc.* **2007**, 129, 10646–10647.
- F. M. Bickelhaupt, K. N. Houk, *Angew. Chem. Int. Ed.* **2017**, 56, 10070–10086.
