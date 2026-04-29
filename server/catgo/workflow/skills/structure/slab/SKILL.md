---
name: slab-generation
description: >
  Use when the user asks to generate a surface slab from a bulk crystal,
  specifying Miller indices, number of layers, vacuum thickness, or supercell size.
---

# Slab Generation

## Overview

A slab model represents a crystal surface: a finite number of atomic layers
with vacuum above and below. Required for any surface chemistry calculation.

The `slab_gen` task type uses ferrox (Rust) `generate_slab` internally for
fast slab cutting. The c axis of the output slab is always perpendicular to
the ab plane (the surface plane).

## Task Type: `slab_gen`

- **Type:** `slab_gen` (local task, no HPC needed)
- **Engine:** ferrox (Rust) `surfaces.generate_slab`
- **Outputs:** `structure` (slab as JSON)

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `structure` | JSON | required | Bulk crystal structure input |
| `miller` | tuple | (1, 1, 0) | Miller index (h, k, l) for surface orientation |
| `layers` | int | 4 | Number of atomic layers in the slab |
| `vacuum` | float | 15.0 | Vacuum thickness in Angstroms |
| `thickness` | float | 10.0 | Minimum slab thickness in Angstroms |

### Miller Index Quick Reference

| Surface | Miller Index | Structure Type | Common Use |
|---------|-------------|----------------|------------|
| FCC (111) | (1,1,1) | Close-packed | Pt, Pd, Au, Cu catalysis |
| FCC (100) | (1,0,0) | Square surface | Open face, higher activity |
| FCC (110) | (1,1,0) | Ridged surface | Step edges |
| BCC (110) | (1,1,0) | Close-packed | Fe, W surfaces |
| BCC (100) | (1,0,0) | Open surface | Fe catalysis |
| Rutile (110) | (1,1,0) | Most stable | TiO2, RuO2 catalysis |
| Perovskite (001) | (0,0,1) | AO or BO2 terminated | SrTiO3, LaCoO3 |

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Miller index** — determines surface orientation and active site geometry; e.g., FCC(111) is close-packed while (110) has ridged surface with step edges
- **Number of layers** — too few layers (< 4) gives unconverged surface energy; production calculations need 5-6 layers minimum
- **Termination choice** — critical for oxides (e.g., RuO2(110) O-terminated vs metal-terminated); wrong termination invalidates the surface chemistry model

🟡 **Recommend confirming:**
- Vacuum thickness (default: 15 A) — increase to 20 A for charged surfaces or large dipole corrections; 12 A acceptable with LDIPOL
- Supercell size — 1x1 slab has unphysical adsorbate-adsorbate interactions; expand to at least 2x2 for adsorbate studies
- Fixed layers (default: freeze bottom 2) — adjust based on total slab thickness; for 6-layer slab, freeze bottom 3

🟢 **Safe defaults:**
- c perpendicular to ab orientation (ferrox guarantees this)
- Vacuum along c direction
- layers = 4 for initial testing
- vacuum = 15.0 A

## MCP Workflow

### Step 1: Fetch bulk crystal

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Pt", "provider": "mp"
}}
```

### Step 2: Generate slab (interactive viewer)

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab",
  "miller_index": [1, 1, 1],
  "min_slab_size": 12.0,
  "min_vacuum_size": 15.0
}}
```

If multiple terminations are returned, the tool lists them. Select the
desired termination:

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab",
  "miller_index": [1, 1, 1],
  "min_slab_size": 12.0,
  "min_vacuum_size": 15.0,
  "termination_index": 0
}}
```

### Step 3: PENDING_REVIEW -- verify the slab

The user should inspect the slab before proceeding. Check:
- Correct surface termination (especially for oxides)
- Slab thickness is adequate (5+ layers for production)
- No dangling bonds or polar surface artifacts
- Vacuum gap is sufficient (15+ A)

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

### Step 4: Make supercell for adsorbate calculations

A 1x1 slab is usually too small (periodic image interactions). Expand to
at least 2x2 in the surface plane. Never scale in z (vacuum direction):

```json
{"tool": "catgo_structure", "arguments": {
  "action": "supercell",
  "scaling": [2, 2, 1]
}}
```

### Step 5: Submit geometry optimization

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task",
  "params": {
    "task_type": "geo_opt",
    "software": "vasp",
    "ENCUT": 520,
    "freeze_mode": "layers",
    "freeze_layers": 2,
    "system_name": "Pt111_slab"
  }
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("Pt(111) slab")

# Bulk input
inp = wf.add_task("structure_input", structure=pt_bulk_json)

# Cut slab using ferrox
slab = wf.add_task("slab_gen",
    structure=inp.output.structure,
    miller=(1, 1, 1),
    layers=4,
    vacuum=15.0,
    thickness=12.0)

# PENDING_REVIEW: user should check the slab before submitting geo_opt
# Verify correct termination, adequate thickness, and no polar artifacts

# Geometry optimization
opt = wf.add_task("geo_opt",
    structure=slab.output.structure,
    software="vasp",
    ENCUT=520,
    freeze_mode="layers",
    freeze_layers=2)

wf.submit()
```

## Workflow Engine (catgo_workflow) Batch Example

Using the graph-based workflow editor with batch operations:

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "batch",
  "workflow_id": "wf_123",
  "operations": [
    {"op": "add_node", "node_type": "slab_gen", "label": "slab1",
     "params": {"miller": [1, 1, 0], "layers": 4, "vacuum": 15.0}},
    {"op": "add_node", "node_type": "geo_opt", "label": "go1",
     "params": {"software": "vasp", "ENCUT": 520}},
    {"op": "connect", "from_id": "<structure_input_id>", "to_id": "slab1"},
    {"op": "connect", "from_id": "slab1", "to_id": "go1",
     "from_handle": "structure", "to_handle": "structure"}
  ]
}}
```

## DAG Structure

```
bulk_crystal --> slab_gen --> [PENDING_REVIEW] --> geo_opt
```

## Slab Thickness Guidelines

| Application | thickness (A) | Approx. Layers (FCC) |
|-------------|---------------|---------------------|
| Quick test | 8.0 | 3-4 |
| Production adsorption | 12.0 | 5-6 |
| Accurate work function | 15.0 | 7-8 |
| Subsurface diffusion | 18.0+ | 9+ |

### Vacuum Thickness

- 15 A minimum for standard DFT (prevents periodic image interaction)
- 20 A for charged surfaces or large dipole corrections
- With dipole correction (LDIPOL, IDIPOL=3): 12 A can be sufficient

## Layer Freezing

For a 4-layer slab:
- Layers 1-2 (bottom): freeze during geo_opt and freq
- Layers 3-4 (top): free to relax

In VASP, constrained atoms use Selective Dynamics (T/F flags).
CatGo handles this via `freeze_mode="layers"` in the geo_opt/freq task.

## Oxide Slabs

For oxides (TiO2, RuO2, IrO2), the slab may have multiple terminations.
For rutile (110):
- **O-terminated**: bridging oxygen rows on surface (most common, most stable)
- **Metal-terminated**: exposed cation rows (CUS sites)

Select based on experimental relevance and thermodynamic stability.

## Common Pitfalls

1. Always start from a BULK crystal. Cutting a slab from an already-cut
   slab produces garbage.
2. The c axis is always perpendicular to the ab plane in the output slab.
   Vacuum is along the c direction. Never use supercell scaling in z
   (e.g., [2,2,2] would double the vacuum AND the slab, wasting compute).
3. For non-cubic systems, verify the Miller index orientation is correct.
   Hexagonal systems use 3-index notation (h,k,l) not 4-index (h,k,i,l).
4. Oxide slabs may be polar (e.g., ZnO(0001)). Polar slabs have a net
   dipole and require either reconstruction, passivation, or dipole
   correction. Check with `catgo_view` after generation.
5. After supercell expansion, atom indices change. Re-identify surface
   atoms before placing adsorbates.
6. For doped slabs, ALWAYS generate the slab from pristine bulk FIRST,
   then dope the slab. Doping bulk before slabbing replicates the dopant
   once per bulk repeat in slab thickness, giving unrealistically high
   concentrations.
