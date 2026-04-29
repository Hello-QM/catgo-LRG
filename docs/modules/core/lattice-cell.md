# Lattice & Cell Operations

Functions for working with crystal lattice parameters, coordinate transformations, and unit cell manipulation.

**Source:** `src/lib/structure/lattice-ops.ts`, `src/lib/structure/pbc.ts`

## Lattice Representation

The lattice is stored as a 3x3 matrix where **rows are lattice vectors** (pymatgen convention):

```
matrix = [
  [a1, a2, a3],   // a-vector
  [b1, b2, b3],   // b-vector
  [c1, c2, c3]    // c-vector
]
```

Fractional-to-Cartesian conversion: `xyz = M^T * abc`

## Key Functions

### Parameter Conversion

```typescript
// Convert lattice parameters to 3x3 matrix
params_to_matrix(a, b, c, alpha, beta, gamma): number[][]

// Extract lattice parameters from matrix
matrix_to_params(matrix): { a, b, c, alpha, beta, gamma }
```

### Coordinate Transformations

```typescript
// Cartesian (xyz) to fractional (abc) coordinates
cartesian_to_fractional(xyz, lattice_matrix): number[]

// Fractional (abc) to Cartesian (xyz) coordinates
fractional_to_cartesian(abc, lattice_matrix): number[]
```

### Cell Manipulation

```typescript
// Update specific lattice parameters
update_lattice_params(structure, { a?, b?, c?, alpha?, beta?, gamma? }): Structure

// Apply a 3x3 transformation matrix to the lattice
apply_transform_matrix(structure, transform): Structure

// Rotate/scale/shear lattice
transform_lattice(structure, matrix): Structure

// Ensure right-handed coordinate system
ensure_right_handed(lattice_matrix): number[][]
```

### Vacuum & Bounding Box

```typescript
// Add vacuum layer along a direction (for slab preparation)
add_vacuum_layer(structure, vacuum_thickness, direction): Structure

// Wrap a molecule in an orthogonal bounding box
wrap_molecule_in_box(structure, padding): Structure
```

### Periodic Boundary Conditions

```typescript
// Wrap fractional coordinates to [0, 1) range
wrap_to_unit_cell(structure): Structure

// Find atoms near cell edges that need periodic images
find_image_atoms(structure, tolerance): ImageAtom[]

// Generate PBC image atoms for visualization
get_pbc_image_sites(structure): Site[]
```

## Interactive Lattice Editing

The **LatticePane** component (`LatticePane.svelte`) provides a UI for editing lattice parameters:

- Direct input of a, b, c (in Angstroms) and alpha, beta, gamma (in degrees)
- Real-time update of the 3D visualization
- Transformation matrix application
- Volume display

## Conventions

- **Lattice matrix rows** are lattice vectors (pymatgen convention)
- **Angles** are in degrees for user-facing parameters, radians internally
- **Lengths** are in Angstroms
- Right-handed coordinate system is enforced — `(a x b) . c > 0`
