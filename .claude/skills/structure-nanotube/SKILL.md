---
name: nanotube-generation
description: >
  Use when the user asks to build a nanotube, roll up a 2D sheet into a tube,
  create a carbon nanotube (CNT), boron nitride nanotube (BNNT), or specify
  chiral indices (n, m).
---

# Nanotube Generation

## Overview

Nanotubes are formed by rolling a 2D sheet into a cylinder defined by
chiral indices (n, m). The chirality determines electronic and mechanical
properties.

Common applications:

- **Carbon nanotubes (CNTs)**: electronics, composites, catalysis
- **Boron nitride nanotubes (BNNTs)**: high-temperature insulation, radiation shielding
- **MoS2 / WS2 nanotubes**: lubricants, batteries, photocatalysis
- **Custom 2D roll-ups**: any 2D material loaded in the viewer

## Chirality Quick Reference

| Type | Condition | Electronic Character (CNT) |
|-----------|-----------|---------------------------|
| Armchair | n = m | Metallic |
| Zigzag | m = 0 | Metallic if n mod 3 = 0, else semiconducting |
| Chiral | n != m, m != 0 | Metallic if (n - m) mod 3 = 0, else semiconducting |

## MCP Tools

### catgo_nanotube_info -- Query geometry before building

```json
{"tool": "catgo_nanotube_info", "arguments": {
  "n": 10, "m": 0,
  "bond_length": 1.42
}}
```

Returns diameter, circumference, chiral angle, translational vector length,
and estimated atom count without building the structure. Use this to check
size before committing to a build.

### catgo_nanotube_build -- Build the nanotube

```json
{"tool": "catgo_nanotube_build", "arguments": {
  "n": 10, "m": 0,
  "length": 20.0,
  "bond_length": 1.42
}}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `n`, `m` | Chiral indices | (required) |
| `length` | Tube length in Angstroms | one translational period |
| `bond_length` | C-C bond length in Angstroms | 1.42 |

The tool accepts either a loaded 2D structure from the viewer or
explicit lattice vectors / basis coordinates. For carbon nanotubes,
the default graphene sheet is used automatically.

### Router: `/nanotube/info` (POST), `/nanotube/build` (POST)

## Complete Workflow: (10,0) Zigzag CNT Relaxation

### Step 1: Check nanotube geometry

```json
{"tool": "catgo_nanotube_info", "arguments": {
  "n": 10, "m": 0
}}
```

Verify the diameter (~7.8 A) and atom count are reasonable for DFT.

### Step 2: Build the nanotube

```json
{"tool": "catgo_nanotube_build", "arguments": {
  "n": 10, "m": 0,
  "length": 12.5
}}
```

### Step 3: Verify in viewer

```json
{"tool": "catgo_view", "arguments": {"action": "get_state"}}
```

Check: cylindrical geometry, no overlapping atoms, correct atom count.

### Step 4: Relax with DFT

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "params": {"name": "(10,0) CNT relaxation"}
}}
```

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task", "params": {
    "workflow_id": "<wf_id>",
    "task_type": "geo_opt",
    "params": {"software": "vasp", "ENCUT": 520, "ISPIN": 1,
               "system_name": "CNT-10-0 relax"}
  }
}}
```

## Multi-walled Nanotubes (MWNT)

The backend supports multi-walled nanotubes via additional walls.
Each wall is defined by its own chiral indices. The inter-wall spacing
defaults to ~3.4 A (van der Waals distance for graphitic layers).

## Non-Carbon Nanotubes

To build a BN nanotube or MoS2 nanotube:

1. Fetch or load the 2D monolayer structure (e.g., hexagonal BN)
2. The nanotube builder rolls up whatever 2D structure is loaded

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "crystal", "formula": "BN", "source": "mc3d"
}}
```

Then build the nanotube from the loaded structure.

## Common Pitfalls

1. Large chiral indices (n > 30) produce structures with thousands of atoms.
   Check atom count with `catgo_nanotube_info` before building.
2. The tube length should be at least one translational period for
   meaningful periodic calculations.
3. For DFT on nanotubes, ensure sufficient vacuum in the non-periodic
   directions (at least 12-15 A between periodic images).
4. Bond length 1.42 A is for graphene/CNT. Use 1.45 A for BN, 2.42 A
   for MoS2.
5. Semiconducting CNTs require careful k-point sampling along the tube
   axis. Use at least 1x1x8 k-points for a single unit cell.
