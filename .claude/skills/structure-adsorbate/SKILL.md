---
name: adsorbate-placement
description: >
  Use when the user asks to place an adsorbate molecule on a surface,
  find adsorption sites, or set up a surface+adsorbate model for DFT.
---

# Adsorbate Placement

## Overview

The `adsorbate_place` task type places adsorbate molecules on surface slabs.
It uses ferrox (Rust) `find_adsorption_sites` to locate surface sites, then
the CatGo placement engine (`utils/adsorbate_placement.py`) for Rodrigues
rotation, overlap detection, and multi-dentate support.

## Task Type: `adsorbate_place`

- **Type:** `adsorbate_place` (local task, no HPC needed)
- **Engine:** ferrox site finder + CatGo placement engine
- **Outputs:** `structure` (slab+adsorbate as JSON)

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `structure` | JSON | required | Slab structure input |
| `species` | str | "OH" | Adsorbate species name |
| `site` | str | "ontop" | Site type: "ontop", "bridge", "hollow", or "all" |
| `height` | float | 2.0 | Height above surface in Angstroms |
| `site_index` | int | 0 | Which site of the given type to use (0 = first) |

### Supported Adsorbate Species

| Species | Atoms | Binding Atom | Notes |
|---------|-------|-------------|-------|
| OH | O, H | O | Hydroxyl, O-H = 0.96 A |
| O | O | O | Atomic oxygen |
| OOH | O, O, H | O1 | Hydroperoxo, key OER intermediate |
| H | H | H | Atomic hydrogen |
| H2O | O, H, H | O | Water molecule |
| CO | C, O | C | Carbon monoxide, C-O = 1.13 A |
| CO2 | C, O, O | C | Carbon dioxide, linear |
| N2 | N, N | N | Dinitrogen, N-N = 1.10 A |
| NH | N, H | N | Imide |
| NH2 | N, H, H | N | Amino |
| NH3 | N, H, H, H | N | Ammonia |
| CHO | C, H, O | C | Formyl |
| COOH | C, O, O, H | C | Carboxyl |

### Site Types

| Site | ferrox Type | Coordination | Description |
|------|------------|-------------|-------------|
| ontop | atop | 1-fold | Directly above one surface atom |
| bridge | bridge | 2-fold | Between two surface atoms |
| hollow | hollow3 | 3-fold | Above threefold hollow site |
| all | atop (default) | 1-fold | Auto-selects ontop |

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Adsorbate species** — determines the chemistry being studied; wrong species = wrong intermediate in the reaction pathway
- **Adsorption site (ontop/bridge/hollow)** — different sites have different binding energies; for screening, test all three and report the most stable

🟡 **Recommend confirming:**
- Height above surface (default: 2.0 A) — too close triggers repulsion during geo_opt, too far causes adsorbate to fly away; use 1.5-1.8 A for atomic O, 2.0-2.5 A for molecular species
- Site index (default: 0) — which specific site of the given type; call catgo_analyze(action="adsorption_sites") first to see available sites
- Multi-dentate orientation — for OOH, COOH, and other multi-atom adsorbates, the binding orientation matters; verify with catgo_view after placement

🟢 **Safe defaults:**
- Collision detection enabled (ferrox automatic)
- Automatic site finding via ferrox find_adsorption_sites
- Binding atom orientation follows species convention (O down for OH, C down for CO)

## MCP Workflow: Place Adsorbate on Slab

### Step 1: Generate slab (or use existing)

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Pt", "provider": "mp"
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab",
  "miller_index": [1, 1, 1],
  "min_slab_size": 12.0,
  "min_vacuum_size": 15.0
}}
```

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell",
  "scaling": [2, 2, 1]
}}
```

### Step 2: Find adsorption sites

```json
{"tool": "catgo_analyze", "arguments": {
  "action": "adsorption_sites"
}}
```

This returns all available sites (ontop, bridge, hollow) with coordinates.

### Step 3: Build workflow with adsorbate placement

Using the workflow engine with `adsorbate_place` node:

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "batch",
  "workflow_id": "wf_123",
  "operations": [
    {"op": "add_node", "node_type": "slab_gen", "label": "slab1",
     "params": {"miller": [1, 1, 1], "layers": 4, "vacuum": 15.0}},
    {"op": "add_node", "node_type": "adsorbate_place", "label": "ads1",
     "params": {"species": "OH", "site": "ontop", "height": 2.0, "site_index": 0}},
    {"op": "add_node", "node_type": "geo_opt", "label": "go1",
     "params": {"software": "vasp", "ENCUT": 520, "freeze_mode": "layers", "freeze_layers": 2}},
    {"op": "connect", "from_id": "<structure_input_id>", "to_id": "slab1"},
    {"op": "connect", "from_id": "slab1", "to_id": "ads1",
     "from_handle": "structure", "to_handle": "structure"},
    {"op": "connect", "from_id": "ads1", "to_id": "go1",
     "from_handle": "structure", "to_handle": "structure"}
  ]
}}
```

### Step 4: PENDING_REVIEW -- verify adsorbate position

The user should inspect the structure before submitting geo_opt. Check:
- Adsorbate is at the correct site (ontop/bridge/hollow)
- Height above surface is reasonable (1.5-2.5 A for most species)
- No atom overlaps or unrealistic bond lengths
- Binding atom orientation is correct (e.g., C down for CO, O down for OH)

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

### Step 5: Submit for DFT optimization

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "run",
  "workflow_id": "wf_123",
  "run_config": {"cluster": "expanse", "partition": "shared", "walltime": "04:00:00"}
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("OH on Pt(111)")

# Bulk input
inp = wf.add_task("structure_input", structure=pt_bulk_json)

# Cut slab
slab = wf.add_task("slab_gen",
    structure=inp.output.structure,
    miller=(1, 1, 1),
    layers=4,
    vacuum=15.0)

# Place adsorbate
ads = wf.add_task("adsorbate_place",
    structure=slab.output.structure,
    species="OH",
    site="ontop",
    height=2.0,
    site_index=0)

# PENDING_REVIEW: user should verify adsorbate position before geo_opt

# Geometry optimization
opt = wf.add_task("geo_opt",
    structure=ads.output.structure,
    software="vasp",
    ENCUT=520,
    freeze_mode="layers",
    freeze_layers=2)

wf.submit()
```

## Complete OER Workflow Example

The oxygen evolution reaction (OER) has four intermediates: *OH, *O, *OOH,
and clean slab. Each needs geo_opt + freq + gibbs_energy.

```python
from catgo.workflow import Workflow

wf = Workflow("OER on IrO2(110)")

# Shared bulk input
inp = wf.add_task("structure_input", structure=iro2_bulk_json)
slab = wf.add_task("slab_gen",
    structure=inp.output.structure,
    miller=(1, 1, 0), layers=4, vacuum=15.0)

# --- Clean slab branch ---
slab_opt = wf.add_task("geo_opt", structure=slab.output.structure,
    software="vasp", ENCUT=520, system_name="clean_slab",
    freeze_mode="layers", freeze_layers=2)
slab_freq = wf.add_task("freq", structure=slab_opt.output.structure,
    software="vasp", freeze_mode="layers", freeze_layers=2)
slab_gibbs = wf.add_task("gibbs_energy",
    energy=slab_opt.output.energy,
    frequencies=slab_freq.output.frequencies,
    phase="adsorbed")

# --- *OH branch ---
oh_ads = wf.add_task("adsorbate_place", structure=slab.output.structure,
    species="OH", site="ontop", height=2.0)
oh_opt = wf.add_task("geo_opt", structure=oh_ads.output.structure,
    software="vasp", ENCUT=520, system_name="OH_ads",
    freeze_mode="layers", freeze_layers=2)
oh_freq = wf.add_task("freq", structure=oh_opt.output.structure,
    software="vasp", freeze_mode="layers", freeze_layers=2)
oh_gibbs = wf.add_task("gibbs_energy",
    energy=oh_opt.output.energy,
    frequencies=oh_freq.output.frequencies,
    phase="adsorbed")

# --- *O branch ---
o_ads = wf.add_task("adsorbate_place", structure=slab.output.structure,
    species="O", site="ontop", height=1.8)
o_opt = wf.add_task("geo_opt", structure=o_ads.output.structure,
    software="vasp", ENCUT=520, system_name="O_ads",
    freeze_mode="layers", freeze_layers=2)
o_freq = wf.add_task("freq", structure=o_opt.output.structure,
    software="vasp", freeze_mode="layers", freeze_layers=2)
o_gibbs = wf.add_task("gibbs_energy",
    energy=o_opt.output.energy,
    frequencies=o_freq.output.frequencies,
    phase="adsorbed")

# --- *OOH branch ---
ooh_ads = wf.add_task("adsorbate_place", structure=slab.output.structure,
    species="OOH", site="ontop", height=2.0)
ooh_opt = wf.add_task("geo_opt", structure=ooh_ads.output.structure,
    software="vasp", ENCUT=520, system_name="OOH_ads",
    freeze_mode="layers", freeze_layers=2)
ooh_freq = wf.add_task("freq", structure=ooh_opt.output.structure,
    software="vasp", freeze_mode="layers", freeze_layers=2)
ooh_gibbs = wf.add_task("gibbs_energy",
    energy=ooh_opt.output.energy,
    frequencies=ooh_freq.output.frequencies,
    phase="adsorbed")

# --- Gas-phase references (H2O, H2) ---
h2o_inp = wf.add_task("structure_input", structure=h2o_gas_json)
h2o_opt = wf.add_task("geo_opt", structure=h2o_inp.output.structure,
    software="vasp", ENCUT=520, ISMEAR=0, KPOINTS=[1,1,1],
    system_name="H2O_gas")
h2o_freq = wf.add_task("freq", structure=h2o_opt.output.structure,
    software="vasp")
h2o_gibbs = wf.add_task("gibbs_energy",
    energy=h2o_opt.output.energy,
    frequencies=h2o_freq.output.frequencies,
    phase="gas")

h2_inp = wf.add_task("structure_input", structure=h2_gas_json)
h2_opt = wf.add_task("geo_opt", structure=h2_inp.output.structure,
    software="vasp", ENCUT=520, ISMEAR=0, KPOINTS=[1,1,1],
    system_name="H2_gas")
h2_freq = wf.add_task("freq", structure=h2_opt.output.structure,
    software="vasp")
h2_gibbs = wf.add_task("gibbs_energy",
    energy=h2_opt.output.energy,
    frequencies=h2_freq.output.frequencies,
    phase="gas")

# Free energy diagram
fed = wf.add_task("free_energy_diagram",
    gibbs_values={
        "clean": slab_gibbs.output.gibbs,
        "OH": oh_gibbs.output.gibbs,
        "O": o_gibbs.output.gibbs,
        "OOH": ooh_gibbs.output.gibbs,
        "H2O": h2o_gibbs.output.gibbs,
        "H2": h2_gibbs.output.gibbs,
    },
    step_order=["clean", "OH", "O", "OOH", "O2"])

wf.submit()
```

## DAG Structure (Single Adsorbate)

```
bulk_crystal --> slab_gen --> adsorbate_place --> [PENDING_REVIEW] --> geo_opt
```

## DAG Structure (OER)

```
                                /--> *OH  --> geo_opt --> freq --> gibbs --\
bulk --> slab_gen --> slab -----+--> *O   --> geo_opt --> freq --> gibbs ---+--> free_energy_diagram
                          \    \--> *OOH --> geo_opt --> freq --> gibbs --/
                           \--> clean_slab --> geo_opt --> freq --> gibbs -/
```

## Comparing Multiple Sites

To compare adsorption at different sites (ontop, bridge, hollow), create
separate branches from the same slab:

```python
for site_type in ["ontop", "bridge", "hollow"]:
    ads = wf.add_task("adsorbate_place",
        structure=slab.output.structure,
        species="OH",
        site=site_type,
        height=2.0,
        site_index=0)
    opt = wf.add_task("geo_opt",
        structure=ads.output.structure,
        software="vasp", ENCUT=520,
        system_name=f"OH_{site_type}")
```

## Common Pitfalls

1. Always build the slab and supercell BEFORE placing adsorbates.
   Adding adsorbates to a 1x1 slab gives unphysically high coverage.
2. The initial height matters: too close triggers repulsion, too far
   may cause the adsorbate to fly away during geo_opt. Use 1.5-2.5 A
   for most species.
3. OOH tends to dissociate into O + OH during relaxation on some
   surfaces. Use tight EDIFFG and monitor the trajectory.
4. For bridge and hollow sites, the adsorbate is placed between atoms
   automatically by the ferrox site finder. Do not manually calculate
   midpoints.
5. After placement, always verify with `catgo_view` that no atoms overlap
   and the geometry looks reasonable before submitting to DFT.
6. When using `site_index`, call `catgo_analyze` with
   `action: "adsorption_sites"` first to see available sites and their
   indices.
7. The `site="all"` option defaults to ontop (atop) sites. For specific
   site types, always pass the explicit type name.
