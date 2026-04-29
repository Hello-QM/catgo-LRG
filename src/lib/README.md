# CatGo Component Library (src/lib)

This directory contains the core UI components and logic for the CatGo frontend, built with **Svelte 5** and **Runes**.

## Core Concepts

### 1. Svelte 5 Runes
The frontend uses the new Svelte 5 Runes (`$state`, `$derived`, `$effect`) for reactivity.
- **Global State**: `src/lib/state.svelte.ts` contains the global application state.
- **Settings System**: `src/lib/settings.ts` defines the central settings schema used across the app.

### 2. Main Components
- **Structure Viewer (`src/lib/structure/`)**: The largest and most complex component. Renders 3D crystals/molecules using **Three.js** and **Threlte**.
- **Periodic Table (`src/lib/periodic-table.ts`)**: Interactive periodic table for element selection and data visualization.
- **AI Chat (`src/lib/chat/`)**: Integration with LLM agents (Claude, Gemini) for structure manipulation and natural language control.
- **Trajectory Player (`src/lib/trajectory/`)**: Player for MD trajectories with support for several formats.
- **Plotting (`src/lib/plot/`)**: General scientific plotting components (Bands, DOS, XRD, RDF, Phase Diagrams).

### 3. Key Files
- `index.ts`: Public API for the npm-published package.
- `settings.ts`: Single source of truth for all configurable options.
- `state.svelte.ts`: Shared reactive state.
- `icons.ts`: Centralized SVG icon registry.
- `math.ts`: Geometry and crystallography utility functions.

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| `structure/` | 3D rendering (Atoms, Bonds, Scene, Supercell logic) |
| `chat/` | AI agent UI and tool execution |
| `workflow/` | Visual graph editor for computation pipelines |
| `symmetry/` | Space group analysis (via moyo-wasm) |
| `api/` | TypeScript clients for the Python backend |
| `element/` | Elemental data and properties |
| `io/` | File parsers (CIF, POSCAR, XYZ, etc.) |

## Performance & Rendering

- **GPU Impostors**: Atoms are rendered as ray-sphere intersection impostors in `AtomImpostors.svelte`, allowing O(1) geometry complexity for thousands of atoms.
- **InstancedMesh**: Bonds and atoms use instancing for high performance.
- **WASM Acceleration**: Computationally intensive tasks (bonding, supercells) are offloaded to **ferrox-wasm** (Rust).

## Development Notes

- **`Structure.svelte`**: This is the orchestrator component (~9000 lines). It manages ALL reactive state for the structure viewer.
- **Coordinate Systems**: Be careful with Cartesian vs. Fractional coordinates and screen vs. world space projections (see `CLAUDE.md` for pitfalls).
