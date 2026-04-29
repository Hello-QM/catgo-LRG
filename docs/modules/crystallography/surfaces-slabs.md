# Surfaces & Slabs

Generate surface slabs from bulk crystals using Miller indices, add vacuum layers, and find adsorption sites.

**Source:** `src/lib/structure/miller-slab.ts`, `src/lib/structure/ferrox-wasm.ts`

## Overview

The slab cutter takes a bulk crystal and creates a surface slab by:

1. Specifying Miller indices (h, k, l) to define the surface orientation
2. Setting slab thickness (number of layers)
3. Adding vacuum for surface separation in periodic calculations

Two code paths are available:
- **Preview (JS)** — fast JavaScript preview for real-time visualization
- **Apply (WASM)** — full slab generation via Rust/WASM for final output

## Key Functions

### Miller Index Utilities

```typescript
// Normalize Miller indices by dividing by GCD
normalize_miller(h, k, l): [number, number, number]

// Validate that at least one index is non-zero
validate_miller(h, k, l): boolean

// Convert Miller indices to surface normal in Cartesian coordinates
miller_to_normal(h, k, l, lattice_matrix): number[]
```

### Slab Generation

```typescript
// JavaScript preview pipeline (fast, approximate)
generate_slab_pipeline(structure, miller, thickness, vacuum): SlabPreview

// Full WASM slab generation (accurate, final output)
wasm_generate_slab(structure, miller, min_thickness, min_vacuum): Structure

// Generate slab from configuration object
generate_slab_from_config(structure, config): Structure
```

### Lattice Handedness

```typescript
// Ensure slab lattice is right-handed: (a x b) . z > 0
ensure_slab_right_handed(a_vec, b_vec): { a: number[], b: number[] }
```

### Atom Visibility

```typescript
// Compute per-atom visibility for animated cutting preview
get_atom_visibility(structure, cutting_plane): number[]
```

## Interactive Slab Cutter

The **MillerSlabCutterPane** component provides a UI for:

- **Miller index input** — h, k, l fields
- **Thickness control** — minimum slab thickness in Angstroms
- **Vacuum control** — vacuum layer thickness
- **Live preview** — cutting plane visualization overlaid on the structure
- **Apply** — generate the final slab and replace the structure

### Cutting Plane Visualizer

The `CuttingPlaneVisualizer` renders translucent planes showing where the surface cuts the crystal. Planes are positioned using `center + n*(d - c_proj)` to center on the crystal.

## Adsorption Sites

The **AdsorptionSitePane** uses ray-casting to find surface adsorption sites:

- **Atop** — directly above a surface atom
- **Bridge** — between two surface atoms
- **Hollow** — above the center of 3+ surface atoms

Sites are placed at covalent radius distance from the surface.

## Data Flow

```
Structure.svelte
  ├── passes `structure` to MillerSlabCutterPane (editing)
  ├── passes `displayed_structure` to StructureScene (rendering)
  │   └── includes PBC image atoms from get_pbc_image_sites()
  └── cutting_atom_visibility computed from original structure only
```

## Vacuum Layer

```typescript
// Add vacuum along a lattice direction
add_vacuum_layer(structure, thickness, direction): Structure

// Interactive vacuum box modal
VacuumBoxModal.svelte  // Add vacuum in any direction(s)
```

## Conventions

- Right-handed lattice is always enforced after slab generation
- The WASM path adjusts fractional b-coordinates (negate + wrap) when fixing handedness
- Surface normal is computed from the reciprocal lattice vectors
