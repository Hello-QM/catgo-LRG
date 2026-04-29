# Phase Diagrams

Thermodynamic stability analysis with convex hull computation for binary, ternary, and quaternary systems.

**Source:** `src/lib/phase-diagram/`

## Overview

Phase diagrams show the thermodynamic stability of compounds in a chemical system. CatGO computes convex hulls to determine:

- Which compositions are thermodynamically stable
- Energy above hull (instability measure) for metastable phases
- Decomposition pathways for unstable compounds

## Components

| Component | Description |
|-----------|-------------|
| `PhaseDiagram2D.svelte` | Binary (A-B) and ternary (A-B-C) 2D phase diagrams |
| `PhaseDiagram3D.svelte` | 3D convex hull visualization |
| `PhaseDiagram4D.svelte` | Quaternary (4-component) compositional space |
| `PhaseDiagramControls.svelte` | Legend, color scale, and display options |
| `PhaseDiagramInfoPane.svelte` | Stability information for selected point |
| `PhaseDiagramStats.svelte` | Statistics summary |

## Key Functions

```typescript
// Compute thermodynamic convex hull
compute_convex_hull(entries): ConvexHull

// Calculate energy above hull for each entry
compute_e_hull(entries, hull): number[]

// Sort/filter entries by composition
sort_entries_by_composition(entries): SortedEntries

// Convert to barycentric coordinates (for ternary diagrams)
barycentric_coords(composition): [number, number]

// Full thermodynamic analysis
thermodynamic_analysis(entries): ThermodynamicResult
```

## Diagram Types

### Binary (2D)
- x-axis: composition fraction (A to B)
- y-axis: formation energy (eV/atom)
- Convex hull line connects stable phases
- Points above hull are metastable/unstable

### Ternary (Triangle)
- Three vertices represent pure elements
- Interior points are compositions
- Color-coded by energy above hull
- Tie lines connect stable phases

### 3D / Quaternary
- 3D convex hull surface
- Interactive rotation for 4-component systems
- Projection views available

## Features

- **Color-coded stability** — stable (on hull) vs metastable (above hull)
- **Interactive selection** — click points to see composition details
- **Structure preview** — hover to preview crystal structure
- **Energy above hull** — quantitative instability measure (meV/atom)
- **Decomposition info** — shows which stable phases an unstable compound would decompose into
