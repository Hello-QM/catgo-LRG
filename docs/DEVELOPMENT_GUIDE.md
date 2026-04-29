# CatGo Development Guide

This guide helps developers (and AI assistants like Gemini) understand the architecture decisions for CatGo development.

## Architecture Overview

CatGo uses a hybrid, multi-platform architecture:

- **Frontend**: Svelte 5 (Runes) + Three.js/Threlte for 3D visualization.
- **WASM (Rust)**: High-performance crystallographic computations in the browser (ferrox-wasm).
- **Desktop Shell**: Tauri 2.0 (Rust) for the standalone application.
- **Backend (FastAPI)**: Python-based computation server for heavy lifting (DFT/MD integration, tool execution).
- **Database**: SQLite managed by the Tauri Rust backend (src-tauri).

---

## When to Use Rust + WASM

Use Rust/WASM (the `ferrox` crate) for **computationally intensive operations** that:

1. Run frequently in the browser and must not block the UI.
2. Benefit from low-level optimization (10-50x faster than pure JS).
3. Operate on structures (bonding, supercells, symmetry).

### Implemented WASM Functions

Located in `extensions/rust/src/wasm.rs`:

| Category              | Functions                                                                       | Description                         |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| **Bonding**           | `detect_bonds_radii`, `detect_bonds_solid_angle`, `detect_bonds_electronegativity` | High-performance bond detection     |
| **Supercell**         | `make_supercell_diag`, `make_supercell`                                         | Create diagonal or matrix supercells|
| **Neighbor List**     | `get_neighbor_list`, `get_all_neighbors`, `get_distance_matrix`                 | PBC-aware distance calculations     |
| **Symmetry**          | `analyze_cell`                                                                  | Symmetry analysis via moyo (spglib) |
| **Slab Generation**   | `wasm_generate_slab`                                                            | Surface/slab cutting                |
| **Properties**        | `get_volume`, `get_density`, `get_composition`                                  | Basic structure properties          |

---

## When to Use the Python Backend

Use the FastAPI backend for operations that:

1. Integrate with scientific Python libraries (ASE, pymatgen, RDKit).
2. Run heavy simulations (VASP, QE, LAMMPS, CP2K, ORCA).
3. Provide AI-powered tools via the Model Context Protocol (MCP).
4. Handle complex analysis (Bader charge, d-band center, COHP).

### Backend Responsibilities

| Category             | Operations                                                       |
| -------------------- | ---------------------------------------------------------------- |
| **Simulation**       | Input generation and output parsing for DFT/MD codes             |
| **Tool Execution**   | Unified `TOOL` registry for extensible commands                  |
| **External APIs**    | Query Materials Project, OPTIMADE, PubChem                       |
| **HPC Integration**  | SSH management and job submission to remote clusters             |
| **Analysis**         | Heavy spectroscopy processing (DOS, Bands, XRD)                  |

---

## Tool-First Development

CatGo follows a "Tool-First" architecture where new capabilities are implemented as granular tools.

### Adding a New Tool
1. **Location**: `server/tools/builtin/` (core) or `plugins/` (user/extension).
2. **Definition**: Create a `tool.py` with:
   - A `TOOL` metadata dictionary (name, description, schema).
   - An `async def execute(context)` implementation.
3. **Registration**: The backend automatically discovers these on startup.

---

## Rust/WASM Development Guide

### Project Structure

```
extensions/
├── rust/                    # Main Rust crate (ferrox)
│   ├── src/
│   │   ├── wasm.rs         # WASM bindings (wasm-bindgen)
│   │   ├── bonding.rs      # Bond algorithms
│   │   ├── lattice.rs      # Lattice/Supercell operations
│   │   └── ...
│
└── rust-wasm/              # WASM package for npm (@catgo/ferrox-wasm)
    ├── pkg/                # wasm-pack output
    └── package.json        
```

### Build Commands

```bash
# Build WASM (from extensions/rust)
wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

---

## Desktop Development (Tauri)

- **Backend**: Rust code in `src-tauri/` manages the local SQLite database and PTY terminals.
- **Frontend**: Standalone Vite build in `desktop/` (uses `vite.desktop.config.ts`).
- **Database**: Use Tauri commands (prefixed with `db_`) to interact with the local workspace.

### Commands
```bash
pnpm desktop:dev   # Frontend only (port 3100)
pnpm desktop:serve # Frontend + Python Backend
pnpm tauri:dev     # Full Tauri desktop app
```

---

## Troubleshooting & Pitfalls

Refer to `CLAUDE.md` in the root and subdirectories (especially `server/CLAUDE.md` and `src/lib/structure/CLAUDE.md`) for detailed records of technical pitfalls and performance considerations.
