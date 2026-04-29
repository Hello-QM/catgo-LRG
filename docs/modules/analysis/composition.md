# Composition

Chemical formula handling, element analysis, and composition visualization.

**Source:** `src/lib/composition/`

## Overview

The composition module provides tools for analyzing and displaying the chemical makeup of structures, with multiple chart types and formula formatting options.

## Key Functions

```typescript
// Get element amounts from structure
get_elem_amounts(structure): Record<string, number>

// Format chemical formula with HTML subscripts
format_chemical_formula(composition): string

// Sort elements alphabetically
alphabetical_formula(composition): string

// Sort by electronegativity
electro_neg_formula(composition): string

// Get unique element list
get_elements(structure): string[]

// WASM-accelerated composition analysis
wasm_get_composition(structure): Composition
```

## Visualization Components

| Component | Description |
|-----------|-------------|
| `Composition.svelte` | Main composition display container |
| `BarChart.svelte` | Horizontal bar chart of element fractions |
| `BubbleChart.svelte` | Bubble chart scaled by element amount |
| `PieChart.svelte` | Pie chart of composition |
| `Formula.svelte` | Formatted chemical formula rendering |

## Chart Features

- Element colors follow CPK/Jmol convention
- Hover tooltips show exact amounts and percentages
- Multiple chart types for different visual preferences
- Responsive sizing
