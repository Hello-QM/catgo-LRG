# Periodic Table

Interactive periodic table explorer with property coloring and comprehensive element data for all 118 elements.

**Source:** `src/lib/periodic-table/`, `src/lib/element/`

## Components

| Component | Description |
|-----------|-------------|
| `PeriodicTable.svelte` | Full interactive periodic table |
| `PeriodicTableControls.svelte` | Property selector and color scale controls |
| `PropertySelect.svelte` | Dropdown for choosing which property to display |
| `TableInset.svelte` | Legend/color scale inset |
| `ElementTile.svelte` | Individual element cell with symbol and value |

## Element Detail Components

| Component | Description |
|-----------|-------------|
| `ElementHeading.svelte` | Element name, symbol, and number |
| `ElementPhoto.svelte` | Element appearance image |
| `ElementStats.svelte` | Property table with all data |
| `BohrAtom.svelte` | Bohr model atom diagram |
| `Nucleus.svelte` | Nucleus visualization |

## Element Database

The element database (`src/lib/element/data.ts`) contains comprehensive data for all 118 elements:

### Properties Available

| Category | Properties |
|----------|-----------|
| **Identity** | Symbol, name, atomic number |
| **Mass** | Atomic mass (u) |
| **Radii** | Atomic radius, covalent radius, ionic radius (A) |
| **Electronegativity** | Pauling scale |
| **Position** | Period (row), group (column), block (s/p/d/f) |
| **Classification** | Metal, nonmetal, metalloid, noble gas, halogen, transition metal, lanthanoid, actinoid, alkali, alkaline earth |
| **Physical** | Melting point, boiling point, density, specific heat |
| **Electronic** | Electron configuration, ionization energies, electron affinity |
| **History** | Discoverer, year discovered |
| **Appearance** | Description and color |

## Features

- **Property coloring** — color elements by any numeric property (electronegativity, atomic radius, density, etc.)
- **Color scales** — viridis, plasma, turbo, and other D3 color interpolators
- **Click to select** — view full element details
- **Hover tooltips** — quick property preview
- **Category highlighting** — highlight element groups (metals, nonmetals, etc.)
- **Responsive layout** — adapts to container size
