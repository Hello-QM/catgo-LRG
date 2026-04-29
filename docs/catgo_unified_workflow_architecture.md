# CatGo Unified Workflow Architecture

Last updated: 2026-03-13

## Design Principle

CatGo is a layered hybrid system. Rust and Python have distinct, non-overlapping roles.

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Svelte 5 + Threlte)                      │
│  Graph editor, node palette, run dialog, results UI │
└────────────────────┬────────────────────────────────┘
                     │ REST / WebSocket
┌────────────────────▼────────────────────────────────┐
│  Python Product Layer (FastAPI)                      │
│  Workflow CRUD, project management, results DB,      │
│  MCP tools, chat integration                         │
└────────────────────┬────────────────────────────────┘
                     │ start_workflow()
┌────────────────────▼────────────────────────────────┐
│  Unified Dispatch (engine.py)                        │
│  Pre-flight routing based on node types in graph     │
├─────────────────────┬───────────────────────────────┤
│  Rust-native path   │  Python HPC adapter path      │
│  (canonical)        │  (transitional shim)           │
│                     │                                │
│  catgo_run binary   │  python_engine.py              │
│  DAG scheduler      │  Simple topo-sort loop         │
│  Concurrency ctrl   │  Drives scientific adapters    │
│  Retry / repair     │  SSH + SLURM integration       │
│  State persistence  │  No retry / no repair          │
│                     │                                │
│  tool_bridge.py ◄───┤  engines/vasp.py               │
│  ├ local nodes      │  engines/cp2k.py               │
│  ├ analysis nodes   │  engines/xtb.py                │
│  ├ ORCA nodes       │  engines/sella.py              │
│  └ local LAMMPS/MLP │  engines/lammps.py (HPC)       │
│                     │  engines/mlp.py (HPC)          │
│                     │  utils/hpc_client.py            │
└─────────────────────┴───────────────────────────────┘
```

## Layer Responsibilities

### 1. Rust Execution Kernel (`crates/catgo-graph/`)

Rust is the canonical execution kernel. It owns:

- **GraphTemplate / GraphRun** — DAG structure and execution state
- **Scheduler** — topological ordering, concurrency, parallelism
- **Node lifecycle** — pending → running → completed / failed
- **Retry / repair** — automatic recovery from transient failures
- **Persistence** — SQLite-backed state, file-based artifacts
- **Monitoring** — ExecutionEvent channel, status broadcasts
- **Subgraph / branching** — conditional execution, loops
- **Native tools** — structure_input, supercell_gen, defect_gen, strain_deform, doping_gen (compiled to WASM or native)

The Rust engine communicates with Python via HTTP tool_bridge (`/tool/execute`).

### 2. Python Product/API Layer (`server/`)

Python owns the product surface:

- **FastAPI router** — 73 REST endpoints for workflow CRUD, results, files, projects
- **MCP tools** — 16 actions for AI-driven workflow authoring
- **Chat integration** — frontend chat tools + CLI agent tools
- **Results DB** — ASE database, enriched results, convergence data

### 3. Python Scientific Adapter Layer (`server/workflow/engines/`)

Python owns HPC and scientific ecosystem integration:

- **Input generation** — VASP (INCAR/POSCAR/KPOINTS/POTCAR), CP2K, ORCA, LAMMPS, xTB, Sella, Gaussian
- **SSH/SLURM** — `hpc_client.py` connection pool, SFTP, job submission, polling
- **Custodian** — VASP error recovery and restart
- **pymatgen/ASE** — structure conversion, format I/O
- **Result extraction** — ORCA output parsing, convergence data

These adapters are stable and will persist regardless of execution kernel changes.

### 4. Transitional Compatibility Layer (`server/workflow/python_engine.py`)

A thin orchestration shim that drives Python-backed scientific adapters for workflows the Rust engine cannot yet handle (HPC nodes requiring SSH + SLURM).

**This is NOT a second workflow brain.** It is the minimum orchestration needed to sequence adapter calls until Rust gains SSH/SLURM support. When that happens:
- Delete the topo-sort/layer loop in `python_engine.py`
- Move HPC adapter dispatch into `tool_bridge.py`
- Rename or delete `python_engine.py`

## Current Routing Rules

Routing is decided **before execution starts** in `engine.py:start_workflow()`.

| Graph contains | Route | Engine type in DB |
|---|---|---|
| Only local/analysis/ORCA/build nodes | Rust-native | `rust` |
| Any VASP/CP2K/Gaussian/xTB/Sella/MLP-HPC/LAMMPS-HPC/GROMACS node | Python HPC adapters | `python` |
| Unified nodes (geo_opt, etc.) with software=orca | Rust-native | `rust` |
| Unified nodes with software=vasp/cp2k/etc. | Python HPC adapters | `python` |

The routing function `workflow_needs_python_engine()` resolves unified node types via `_resolve_software()` before checking.

## Future Convergence Direction

```
TODAY                          FUTURE
─────                          ──────
Rust kernel                    Rust kernel
  ├ local tools (native)         ├ local tools (native)
  ├ analysis (tool_bridge)       ├ analysis (tool_bridge)
  ├ ORCA (tool_bridge)           ├ ORCA (tool_bridge)
  └ ✗ HPC blocked               ├ VASP (tool_bridge + SSH)
                                 ├ CP2K (tool_bridge + SSH)
Python shim                      └ all HPC (tool_bridge + SSH)
  ├ topo-sort loop
  ├ VASP adapter               Python adapters (no shim)
  ├ CP2K adapter                  ├ input generation (unchanged)
  └ SSH/SLURM                     ├ result extraction (unchanged)
                                  └ called by Rust via tool_bridge
```

The migration path:
1. Rust `HttpBridgeTool` gains SSH session forwarding
2. `tool_bridge.py` adds HPC dispatch (generate inputs → submit → poll)
3. `python_engine.py` shim is deleted
4. All workflows run through Rust kernel with Python-backed adapters via tool_bridge

No Python scientific adapter code needs to be rewritten in Rust. Only the orchestration shim goes away.
