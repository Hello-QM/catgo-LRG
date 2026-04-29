# Symmetry

Space group detection, Wyckoff position identification, and symmetry analysis using WASM-accelerated algorithms.

**Source:** `src/lib/symmetry/`

## Algorithms

Two symmetry backends are available, both compiled to WASM:

| Algorithm | Package | Description |
|-----------|---------|-------------|
| **Moyo** | `@spglib/moyo-wasm` | Modern Rust reimplementation, recommended |
| **Spglib** | spglib (via WASM) | Classic C library, widely used reference |

## Key Functions

### Space Group Detection

```typescript
// Analyze structure symmetry (space group, point group, crystal system)
analyze_structure_symmetry(structure, algorithm?, tolerance?): SymmetryResult

// Get space group from structure
wasm_get_spacegroup(structure): SpaceGroupInfo
```

### Wyckoff Positions

```typescript
// Identify Wyckoff positions for all atoms
wyckoff_positions_from_moyo(structure): WyckoffResult[]

// Map Wyckoff positions to display atoms (including image atoms)
map_wyckoff_to_all_atoms(wyckoff_result, num_display_atoms): WyckoffMap
```

### Symmetry Operations

```typescript
// Apply symmetry operations to generate equivalent positions
apply_symmetry_operations(structure, operations): Site[]

// Initialize WASM module (called once)
ensure_moyo_wasm_ready(): Promise<void>

// Serialize structure for symmetry analysis
to_cell_json(structure): CellJSON
```

## Symmetry Result

```typescript
interface SymmetryResult {
  spacegroup_number: number      // International Tables number (1-230)
  spacegroup_symbol: string      // Hermann-Mauguin symbol (e.g., "Fm-3m")
  point_group: string            // Point group symbol
  crystal_system: string         // cubic, hexagonal, tetragonal, etc.
  bravais_lattice: string        // P, I, F, A, B, C, R
  wyckoff_positions: WyckoffSite[]
}
```

## Wyckoff Display

Wyckoff positions can be used for atom coloring in the structure viewer:
- Each unique Wyckoff site gets a distinct color
- The `color_mode: "wyckoff"` setting activates this mode
- Helps identify symmetry-equivalent atoms visually

## Bravais Lattices

The module identifies all 14 Bravais lattice types:

| Symbol | Type |
|--------|------|
| P | Primitive |
| I | Body-centered |
| F | Face-centered |
| A, B, C | Base-centered |
| R | Rhombohedral |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `symprec` | number | 0.01 | Symmetry precision tolerance (Angstroms) |
| `symmetry_algorithm` | string | "moyo" | Backend: "moyo" or "spglib" |

## Components

- **SymmetryStats.svelte** — Displays space group, point group, crystal system
- **WyckoffTable.svelte** — Table of Wyckoff positions with multiplicity, letter, and site symmetry
