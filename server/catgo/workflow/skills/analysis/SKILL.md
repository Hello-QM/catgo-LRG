---
name: analysis-router
description: >
  Use when the user asks to analyze computational results: Gibbs free energy,
  OER/HER/CO2RR overpotentials, adsorption energy, convergence tests,
  DOS/d-band analysis, or Bader charge analysis.
---

# Analysis Router

This skill routes analysis requests to the correct sub-skill based on what
the user is asking for.

## Routing Table

| User Intent | Sub-Skill | Key Indicators |
|-------------|-----------|----------------|
| Gibbs free energy, ZPE, thermal corrections | `gibbs/` | "free energy", "ZPE", "entropy", "thermal" |
| OER overpotential | `oer/` | "OER", "oxygen evolution", "water splitting anode" |
| HER overpotential | `her/` | "HER", "hydrogen evolution", "water splitting cathode" |
| CO2 reduction | `co2rr/` | "CO2RR", "CO2 reduction", "carbon dioxide" |
| Adsorption energy | `adsorption/` | "adsorption energy", "binding energy", "E_ads" |
| ENCUT/KPOINTS convergence | `convergence/` | "convergence", "ENCUT test", "k-point test" |
| DOS, d-band center, PDOS | `dos_analysis/` | "DOS", "d-band", "PDOS", "density of states" |
| Bader charge | `charge/` | "Bader", "charge transfer", "charge analysis" |
| MACE Ni benchmark (Kreitz 2021) | `mace_ni_benchmark/` | "Kreitz", "MACE Ni benchmark", "MLP vs DFT-D3 on Ni" |

## MCP Tool: catgo_analyze

All analysis actions use the `catgo_analyze` tool with an `action` parameter.

```json
{"tool": "catgo_analyze", "arguments": {"action": "convergence", ...}}
{"tool": "catgo_analyze", "arguments": {"action": "frequencies", ...}}
{"tool": "catgo_analyze", "arguments": {"action": "forces", ...}}
```

## MCP Tool: catgo_workflow_engine

Most analysis workflows are built as DAGs using the workflow tool.

```json
{"tool": "catgo_workflow_engine", "arguments": {"action": "create", "name": "Analysis WF"}}
{"tool": "catgo_workflow_engine", "arguments": {"action": "add_task", "workflow_id": "...", "task_type": "gibbs_energy", ...}}
```

## Python API Pattern

All analysis workflows follow the same skeleton:

```python
from catgo.workflow import Workflow

wf = Workflow("Analysis name")

# 1. Input structure
inp = wf.add_task("structure_input", structure=structure_json)

# 2. Compute (geo_opt, single_point, freq, etc.)
opt = wf.add_task("geo_opt", structure=inp.output.structure, software="vasp")
frq = wf.add_task("freq", structure=opt.output.structure, software="vasp",
                   freeze_mode="layers", freeze_layers=4)

# 3. Analyze (gibbs_energy, dos_analysis, charge_analysis, etc.)
gib = wf.add_task("gibbs_energy", energy=opt.output.energy,
                   frequencies=frq.output.frequencies, phase="adsorbed")

wf.submit()
```

## Decision Guide

- Single intermediate (H*, OH) --> `her/`, `adsorption/`
- Multiple intermediates in reaction pathway --> `oer/`, `co2rr/`
- Parameter sweep, no reaction --> `convergence/`
- Post-processing existing calculation --> `dos_analysis/`, `charge/`
- Converting DFT energy to thermodynamic quantity --> `gibbs/`

## Common Pitfalls

1. Always run `geo_opt` before `freq` -- frequencies on unrelaxed structures are meaningless.
2. For surface calculations, always use `freeze_mode="layers"` in freq to avoid
   imaginary frequencies from slab bottom atoms.
3. Gibbs energy needs both `energy` (from geo_opt) and `frequencies` (from freq) --
   these come from separate tasks connected via output references.
4. Convergence tests use `single_point` (not `geo_opt`) to isolate the parameter effect.
