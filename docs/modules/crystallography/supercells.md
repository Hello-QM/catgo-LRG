# Supercells

Expand periodic structures by replicating the unit cell along lattice directions.

**Source:** `src/lib/structure/lattice-ops.ts`, `src/lib/structure/ferrox-wasm.ts`

## Overview

Supercell generation creates an n x m x p expansion of the original unit cell, replicating all atoms and scaling the lattice accordingly. This is commonly used for:

- Creating larger simulation cells for DFT or MD
- Visualizing extended crystal structures
- Constructing defect supercells with dilute defect concentration

## Key Functions

```typescript
// Generate n x m x p supercell
generate_supercell_struct(structure, nx, ny, nz): Structure

// Apply arbitrary transformation matrix (3x3)
get_supercell_structure(structure, transform_matrix): Structure
```

## Interactive UI

The **CellSelect** component provides a simple selector for supercell dimensions:

- Input fields for n, m, p (repeat counts along a, b, c)
- One-click supercell generation
- Camera automatically re-aligns after supercell expansion

## How It Works

1. The lattice matrix is scaled: `new_lattice = diag(n, m, p) * original_lattice`
2. For each original atom at fractional position `(fa, fb, fc)`:
   - Generate copies at `((fa + i)/n, (fb + j)/m, (fc + k)/p)` for `i=0..n-1`, `j=0..m-1`, `k=0..p-1`
3. All atom properties (element, occupancy, charge) are preserved

## Transformation Matrix

For non-diagonal expansions (e.g., rotating the cell), use the transformation matrix approach:

```typescript
// Example: 2x2x1 supercell with 45-degree rotation
const transform = [
  [1, 1, 0],
  [-1, 1, 0],
  [0, 0, 1]
]
get_supercell_structure(structure, transform)
```

The new lattice is `M * old_lattice`, and atom positions are mapped accordingly.
