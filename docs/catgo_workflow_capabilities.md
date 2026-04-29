# CatGo Workflow Capabilities

Last updated: 2026-03-13

## Node Classification

### Rust-Native Nodes (via tool_bridge)

These execute through the Rust catgo-graph engine. No HPC session required.

**Local structure operations (18 nodes):**
structure_input, slab_gen, adsorbate_place, condition, loop, merge, analysis, export_data, free_energy, her_analysis, doping_gen, defect_gen, supercell_gen, strain_deform, intercalation, heterostructure_build, nanotube_build, water_solvate, passivate, polymer_build, polymer_crosslink

**Analysis (5 nodes):**
dos_analysis, cohp_analysis, md_analysis, convergence_check, energy_compare

**ORCA quantum chemistry (6 nodes):**
orca_opt, orca_sp, orca_freq, orca_neb_ts, orca_irc, orca_uvvis

**Local-mode LAMMPS (2 nodes, when execution_mode=local):**
lammps_md, polymer_md

**Local-mode MLP (2 nodes, when execution_mode=local):**
mlp_relax, mlp_md

### Python-Backed HPC Nodes (via transitional shim)

These require SSH connection + SLURM/PBS job scheduler. Routed to Python HPC adapters.

**VASP (8 nodes):**
vasp_relax, vasp_static, vasp_md, bulk_opt, slab_relax, frequency, electronic, reference_mol

**CP2K (5 nodes):**
cp2k_geopt, cp2k_static, cp2k_cellopt, cp2k_md, cp2k_freq

**Gaussian (3 nodes):**
gaussian_opt, gaussian_sp, gaussian_freq

**xTB (2 nodes):**
xtb_relax, xtb_static

**Sella (1 node):**
sella_ts

**MLP in HPC mode (2 nodes):**
mlp_relax, mlp_md

**LAMMPS in HPC mode (2 nodes):**
lammps_md, polymer_md

**Polymer simulation (2 nodes):**
polymer_deform, glass_transition

**GROMACS (1 node):**
gromacs_md

**HPC analysis (1 node):**
charge_analysis (Bader)

### Unified/Hybrid Nodes (8 node types)

These resolve at dispatch time based on `params.software`:

| Unified type | software=vasp | software=orca | software=cp2k | software=xtb | software=mlp |
|---|---|---|---|---|---|
| geo_opt | vasp_relax → Python | orca_opt → Rust | cp2k_geopt → Python | xtb_relax → Python | mlp_relax → depends on mode |
| single_point | vasp_static → Python | orca_sp → Rust | cp2k_static → Python | xtb_static → Python | — |
| cell_opt | bulk_opt → Python | — | cp2k_cellopt → Python | — | — |
| md | vasp_md → Python | — | cp2k_md → Python | — | mlp_md → depends on mode |
| freq | frequency → Python | orca_freq → Rust | cp2k_freq → Python | — | — |
| ts_search | — | orca_neb_ts → Rust | — | — | — |
| irc | — | orca_irc → Rust | — | — | — |
| uvvis | — | orca_uvvis → Rust | — | — | — |

Default software is `vasp` if not specified.

## Known Limitations

### Not Yet Implemented

| Node type | Status | What's missing |
|---|---|---|
| gaussian_opt/sp/freq | Input gen raises RuntimeError | No `engines/gaussian.py` generator |
| gromacs_md | Input gen raises RuntimeError | No `engines/gromacs.py` generator |

### Python Shim Limitations

The transitional Python orchestration shim (`python_engine.py`) has intentional limitations. It is not a full execution engine:

- **No retry/repair** — if a step fails, the entire workflow fails
- **No concurrency control** — all nodes in a layer run via `asyncio.gather`, no backpressure
- **No resume from checkpoint** — resume re-executes all nodes (does not skip completed steps)
- **Simple topo-sort** — no subgraph execution, no conditional branching within the shim (condition/loop nodes are handled by their own handlers)

### Mixed Execution

A workflow containing both Rust-native and Python-backed nodes currently runs entirely through the Python shim. The shim delegates local/analysis/ORCA nodes to the same handlers that `tool_bridge.py` uses, so behavior is identical — but the orchestration overhead is Python's simple loop instead of Rust's DAG scheduler.

## Execution Path Summary

```
Workflow with only local/ORCA nodes
  → Rust catgo-graph engine
  → Full DAG scheduling, retry, concurrency
  → Status: production-ready

Workflow with VASP/CP2K/HPC nodes
  → Python HPC adapter shim
  → Simple layer execution
  → SSH + SLURM job submission
  → Status: functional, transitional

Workflow with Gaussian/GROMACS nodes
  → Python HPC adapter shim
  → Fails at input generation
  → Status: not yet supported
```
