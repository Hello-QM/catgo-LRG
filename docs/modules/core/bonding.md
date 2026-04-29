# Bonding

Automatic bond detection and analysis with multiple strategies, interactive bond editing, and coordination number computation.

**Source:** `src/lib/structure/bonding.ts`, `src/lib/coordination/`

## Bond Detection Strategies

| Strategy | Description |
|----------|-------------|
| **Distance** | Bond if distance < sum of covalent radii * factor |
| **Electronegativity** | Distance-based with electronegativity weighting |
| **VESTA** | Uses VESTA bond-length database for more accurate detection |

## Key Functions

### Bond Calculation

```typescript
// Compute all bonds in a structure
calculate_bonding(structure, strategy?): Bond[]

// WASM-accelerated bonding (faster for large structures)
wasm_calculate_bonding(structure): Bond[]

// Get default bond length for an element pair
get_default_bond_length(elem_a, elem_b): number

// Get all bond length options for a pair
get_available_bond_lengths(elem_a, elem_b): BondLength[]
```

### Bond Geometry

```typescript
// Compute 4x4 transform matrix for rendering a bond cylinder
compute_bond_transform(pos_a, pos_b, radius): Matrix4

// Fast bond position update after atom moves (avoids full recalculation)
update_bond_positions(bonds, new_positions): Bond[]

// Generate unique key for bond pair (avoids duplicates)
get_bond_key(index_a, index_b): string
```

### Coordination Analysis

```typescript
// Calculate coordination number distribution
calculate_coordination(structure, bonds): CoordinationResult

// Split modes for coordination analysis
SPLIT_MODES: "by_element" | "by_structure" | "none"
```

### Neighbor Lists

```typescript
// WASM-accelerated neighbor finding
wasm_calculate_neighbor_list(structure, cutoff): NeighborList
```

## Bond Editing

The structure viewer supports interactive bond editing in **Pencil Mode > Bonds** tab:

### Creating Bonds

Two methods are available:

- **Drag-to-connect** — Click and drag from one atom to another. A ghost bond preview follows your cursor during the drag, showing exactly where the bond will be created. Release on the target atom to confirm.
- **Click-click** — Click the first atom (a green torus indicator appears), then click the second atom. Works as a fallback when drag isn't convenient.

The ghost bond preview matches the element color of the source atom and uses the same thickness as real bonds for an accurate preview.

### Managing Bonds

- **Select bonds** — Click on an existing bond to select it (yellow highlight). Shift-click to multi-select.
- **Delete bonds** — Press Delete or Backspace with bonds selected to remove them.
- **Cancel** — Press Escape to cancel an in-progress bond creation or clear bond selection.

## Coordination Visualization

The `CoordinationBarPlot` component displays coordination number distributions as a bar chart, with options to split by element type or structure.

## Performance

- Structures with **>50 atoms** use a spatial grid for O(N) neighbor search
- The WASM path (`wasm_calculate_bonding`) is significantly faster for large structures
- Bond transforms use instanced rendering for efficient GPU utilization

## Bond Data Structure

```typescript
interface Bond {
  from: number      // Atom index A
  to: number        // Atom index B
  from_pos: number[] // Position of atom A [x, y, z]
  to_pos: number[]   // Position of atom B [x, y, z]
  length: number     // Bond length in Angstroms
  order?: number     // Bond order (if available)
}
```
