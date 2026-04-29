---
name: strain-deformation
description: >
  Use when the user asks to apply strain, deformation, lattice distortion,
  or mechanical loading to a periodic structure (uniaxial, biaxial,
  hydrostatic, or shear).
tags: [structure, strain, deformation, mechanical, elastic]
---

# Strain / Deformation

## Overview

Applies mechanical strain to periodic structures by deforming the lattice.
This is used for:

- **Strain engineering**: Tuning electronic structure and catalytic activity
- **Elastic property calculations**: Computing elastic tensors from stress-strain curves
- **Phase stability**: Testing structural stability under deformation
- **Epitaxial strain**: Modeling lattice mismatch in thin films and heterostructures

Four strain types are supported:
- **Uniaxial**: Stretch/compress along a single axis (a, b, or c)
- **Biaxial**: Stretch/compress in the ab-plane simultaneously
- **Hydrostatic**: Uniform expansion/compression in all three directions
- **Shear**: Off-diagonal deformation (tilting)

## MCP Tool: catgo_structure (via REST /build/strain)

Strain is applied through the `/build/strain` endpoint. In the full MCP
server, use the `catgo_build_strain` tool.

### Apply Uniaxial Strain

Stretch a structure by 2% along the c-axis:

```json
POST /build/strain
{
  "structure": { ... },
  "strain_type": "uniaxial",
  "axis": "c",
  "magnitude": 0.02,
  "n_steps": 1
}
```

### Apply Biaxial Strain

Stretch in the ab-plane (common for surface/thin-film studies):

```json
POST /build/strain
{
  "structure": { ... },
  "strain_type": "biaxial",
  "magnitude": 0.03,
  "n_steps": 1
}
```

### Apply Hydrostatic Strain

Uniform expansion by 1%:

```json
POST /build/strain
{
  "structure": { ... },
  "strain_type": "hydrostatic",
  "magnitude": 0.01,
  "n_steps": 1
}
```

### Apply Shear Strain

Off-diagonal deformation:

```json
POST /build/strain
{
  "structure": { ... },
  "strain_type": "shear",
  "magnitude": 0.02,
  "n_steps": 1
}
```

### Generate Multiple Strain Steps

Generate a series of strained structures (e.g., for elastic constant
calculations). Setting `n_steps > 1` creates structures at evenly
spaced magnitudes from `-|magnitude|` to `+|magnitude|`:

```json
POST /build/strain
{
  "structure": { ... },
  "strain_type": "uniaxial",
  "axis": "c",
  "magnitude": 0.05,
  "n_steps": 11
}
```

This returns 11 structures at -5%, -4%, ..., 0%, ..., +4%, +5% strain.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| strain_type | string | "uniaxial" | Type: `uniaxial`, `biaxial`, `hydrostatic`, `shear` |
| axis | string | "c" | Axis for uniaxial strain: `a`, `b`, or `c` |
| magnitude | float | 0.02 | Strain magnitude (fraction, e.g., 0.02 = 2%) |
| n_steps | int | 1 | Number of strain steps (1 = single deformation) |
| structure | dict | -- | Structure in pymatgen dict format |

## Complete Workflow: Elastic Constants via Stress-Strain

### 1. Fetch and relax structure

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "Cu", "provider": "mp"
}}
```

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "create", "name": "Cu elastic constants"
}}
```

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_elastic",
  "node_type": "cell_opt",
  "params": {"software": "vasp", "ENCUT": 520,
             "system_name": "Cu cell opt"}
}}
```

### 2. Apply strain series and compute stresses

For each deformation mode (6 independent strains for cubic symmetry),
apply a series of strains and run single-point calculations to get
stress tensors.

### 3. Fit elastic tensor

Use the workflow `elastic_analysis` node to fit the elastic tensor from
the stress-strain data:

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_elastic",
  "node_type": "elastic_analysis",
  "params": {"sym_reduce": true, "n_strains": 6, "strain_magnitude": 0.02}
}}
```

## Deformation Matrix Reference

| Strain Type | Deformation Matrix |
|-------------|-------------------|
| Uniaxial (c) | diag(1, 1, 1+e) |
| Biaxial (ab) | diag(1+e, 1+e, 1) |
| Hydrostatic | diag(1+e, 1+e, 1+e) |
| Shear | [[1, e, 0], [0, 1, 0], [0, 0, 1]] |

Where `e` is the strain magnitude.

## Common Pitfalls

1. Strain magnitudes are fractional (0.02 = 2%). Typical values for
   elastic property calculations are 0.5-5%.
2. Always relax the original structure first (cell_opt) before applying
   strain. Straining an unrelaxed structure gives meaningless results.
3. For strain-activity relationships in catalysis, apply strain to the
   slab (not the bulk) and re-optimize adsorbate positions. The strained
   slab should have fixed lattice vectors during geo_opt (ISIF=2).
4. When using `n_steps > 1`, structures are generated symmetrically
   around zero strain. This is important for elastic constant fitting
   (need both tensile and compressive data).
5. Shear strain breaks symmetry. For elastic constant calculations,
   use the full set of 6 independent deformations for the relevant
   crystal system.
