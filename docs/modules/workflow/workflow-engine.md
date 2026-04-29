# Workflow Engine

The workflow engine is CatGO's system for building and executing multi-step computational pipelines. It provides a visual node-based editor, REST/WebSocket-style monitoring surfaces, async backend execution, and persistent workflow/project state.

## Current Status

As of 2026-03, the workflow stack has a few important properties that older docs often miss:

- The visual editor lives in `src/lib/workflow/`.
- Workflow CRUD and execution APIs live under `server/routers/workflow.py`.
- AI can reach workflows through two separate layers:
  - frontend chat workflow tools in `src/lib/chat/workflow-tools.ts`
  - MCP `catgo_workflow` in `server/mcp_tools/server.py`
- The MCP `create` path currently auto-adds one `structure_input` node.
- The MCP `run` path starts execution immediately; it does not open a confirmation dialog.
- Connection handles matter. Omitting them falls back to `structure`, which is only safe for simple single-structure chains.

## Scope Note

The large node tables below are still useful as background, but they are no longer a perfect source of truth for:
- exact node names
- alias mapping
- handle names
- agent-facing workflow behavior

For current implementation details, prefer:
- `src/lib/workflow/node-definitions.ts`
- `src/lib/chat/workflow-tool-executor.ts`
- `server/mcp_tools/server.py`
- `WORKFLOW_BUGS.md`

## Architecture

```
┌──────────────────────────────────┐
│  Workflow Editor (Svelte 5)      │  Visual graph builder
│  Node palette, edge connections, │  Templates, undo/redo
│  parameter forms, run config     │
├──────────────────────────────────┤
│  Workflow API (FastAPI)          │  REST + WebSocket
│  CRUD, execution control,       │  Real-time monitoring
│  results, templates             │
├──────────────────────────────────┤
│  Workflow Engine (async Python)  │  Topological execution
│  Job submission, polling,        │  Custodian error handling
│  result extraction, ASE DB       │
├──────────────────────────────────┤
│  HPC Cluster (SSH)               │  VASP, MLP, Bader
│  SLURM / PBS scheduler           │  Remote file I/O
└──────────────────────────────────┘
```

### Execution Model

1. **Topological sort** — Nodes are sorted into layers based on dependencies
2. **Layer-by-layer execution** — All nodes in a layer run in parallel; the next layer starts only after the current one completes
3. **Routing** — Each node is routed to the appropriate executor:
   - **HPC**: VASP calculations, MLP calculations, Bader analysis
   - **Local**: Structure transformations, analysis, logic nodes
4. **Result passing** — Output structures and energies flow downstream via edges

### State Machine

```
Workflow:  draft → running → (paused) → completed / failed
Step:      pending → queued → running → completed / failed / skipped
```

---

## Node Reference

### Input Nodes

#### Structure Input

Provides the starting structure for a workflow.

| Parameter | Type | Description |
|-----------|------|-------------|
| source | select | File upload, Materials Project, OPTIMADE, ASE DB, or editor |
| structure | text | POSCAR-format structure data |

---

### DFT Calculation Nodes

All DFT nodes run on an HPC cluster via SSH. They generate VASP input files (INCAR, POSCAR, KPOINTS), submit a job, poll for completion, and extract results.

#### VASP Relax

Geometry optimization using conjugate gradient, quasi-Newton, or FIRE.

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| ENCUT | 520 | 200–900 eV | Plane-wave cutoff energy |
| EDIFF | 1e-5 | 1e-4 to 1e-7 | Electronic convergence |
| EDIFFG | -0.02 | — | Ionic convergence (negative = force in eV/A) |
| ISIF | 3 | 2/3/4/7 | 2 = fix cell, 3 = full, 4 = fix volume, 7 = volume only |
| NSW | 200 | 1–1000 | Maximum ionic steps |
| IBRION | 2 | 1/2/3 | 1 = Quasi-Newton, 2 = CG, 3 = FIRE (requires VTST) |
| KPOINTS | 4x4x4 | — | k-point mesh |
| double_relax | false | — | Run twice (atomate2 DoubleRelaxMaker pattern) |
| NCORE | 4 | 1–64 | Cores per orbital band |
| LWAVE | false | — | Write WAVECAR |
| LCHARG | true | — | Write CHGCAR |
| custom_incar | — | — | Additional INCAR tags (free text) |

**Outputs:** Relaxed structure (CONTCAR), total energy, forces, stress tensor.

#### VASP Static

Single-point energy calculation on a fixed geometry.

| Parameter | Default | Description |
|-----------|---------|-------------|
| ENCUT | 520 | Plane-wave cutoff |
| EDIFF | 1e-6 | Tighter electronic convergence |
| ISMEAR | -5 | Tetrahedron method with Blochl corrections |
| LORBIT | 11 | Project DOS onto atoms |
| NEDOS | 3001 | DOS grid points |
| KPOINTS | 6x6x6 | Denser k-grid for accurate DOS |

**Outputs:** Energy, DOS data, charge density.

#### VASP MD

Ab initio molecular dynamics.

| Parameter | Default | Description |
|-----------|---------|-------------|
| TEBEG | 300 | Starting temperature (K) |
| NSW | 5000 | Number of MD steps |
| POTIM | 1.0 | Timestep (fs) |
| SMASS | -1 | Thermostat: -1 = NVE, 0 = NVT scaled, 3 = Nose-Hoover |
| ENCUT | 400 | Lower cutoff acceptable for MD |

**Outputs:** Trajectory, energy vs. time, temperature profile.

#### Electronic Analysis

Post-processing for electronic structure properties.

| Parameter | Default | Description |
|-----------|---------|-------------|
| analysis | dos | Type: dos, bader, cohp |
| NEDOS | 3001 | DOS energy grid points |
| LORBIT | 11 | Orbital projection level |
| ISMEAR | -5 | Tetrahedron for accurate DOS |

**Outputs:** DOS data, Bader charges, or COHP bonding analysis (depends on `analysis` type).

#### Frequency

Vibrational frequency calculation via finite differences.

| Parameter | Default | Description |
|-----------|---------|-------------|
| IBRION | 5 | 5 = finite differences, 6 = all directions |
| NFREE | 2 | 2 or 4 displacements per direction |
| POTIM | 0.015 | Displacement step size (A) |
| EDIFF | 1e-7 | Tight electronic convergence for forces |

**Outputs:** Frequencies (cm-1), zero-point energy (ZPE), IR intensities.

---

### ML Potential Nodes

ML potential nodes run on HPC but are much faster than DFT. Use them for pre-screening, pre-relaxation, or long-timescale dynamics.

#### MLP Relax

| Parameter | Default | Description |
|-----------|---------|-------------|
| model | MACE-MP | ML potential: MACE-MP, CHGNet, M3GNet |
| fmax | 0.01 | Force convergence criterion (eV/A) |

**Outputs:** Relaxed structure, energy.

#### MLP MD

| Parameter | Default | Description |
|-----------|---------|-------------|
| model | MACE-MP | ML potential model |
| temperature | 300 | Temperature (K) |
| steps | 10000 | Number of MD steps |
| timestep | 1.0 | Timestep (fs) |

**Outputs:** Trajectory, energy time series.

---

### Surface Catalysis Nodes (NRR)

Specialized nodes for nitrogen reduction reaction studies.

#### Bulk Optimization

Dense k-grid relaxation for bulk crystals.

| Parameter | Default | Description |
|-----------|---------|-------------|
| KPOINTS | 9x9x9 | Dense k-grid |
| ISIF | 3 | Full cell + ionic relaxation |
| ENCUT | 520 | Standard cutoff |

#### Slab Generation

Cut a surface slab from a bulk crystal (runs locally).

| Parameter | Default | Description |
|-----------|---------|-------------|
| miller_h, miller_k, miller_l | 1, 1, 1 | Miller indices |
| layers | 4 | Number of atomic layers |
| vacuum | 15.0 | Vacuum thickness (A) |
| supercell_a, supercell_b | 2, 2 | In-plane supercell |

#### Slab Relaxation

Surface relaxation with frozen bottom layers and dipole correction.

| Parameter | Default | Description |
|-----------|---------|-------------|
| ISIF | 2 | Fix cell shape, relax ions |
| freeze_layers | 2 | Number of bottom layers to freeze |
| LDIPOL | true | Dipole correction for slab asymmetry |

#### Adsorbate Placement

Place molecules on surface adsorption sites (runs locally).

| Parameter | Default | Description |
|-----------|---------|-------------|
| adsorbate | N2 | Molecule to place (*N2, *NH3, *H, etc.) |
| site | ontop | Site type: ontop, bridge, fcc, hcp |
| orientation | end-on | Molecule orientation: end-on, side-on |

#### Reference Molecule

Gas-phase molecule calculation for thermodynamic reference.

| Parameter | Default | Description |
|-----------|---------|-------------|
| molecule | N2 | Reference molecule (N2, H2, NH3) |
| box_size | 20 | Cubic box size (A) |
| KPOINTS | 1x1x1 | Gamma-point only |

#### Free Energy Diagram

Calculate reaction free energies along a pathway.

| Parameter | Default | Description |
|-----------|---------|-------------|
| pathway | distal | Reaction mechanism: distal, alternating |
| potential | -0.1 | Applied potential (V vs. RHE) |
| temperature | 298.15 | Temperature (K) |

**Formula:** `DG = DE + DZPE - TDS + neU`

#### HER Analysis

Assess hydrogen evolution selectivity.

| Parameter | Default | Description |
|-----------|---------|-------------|
| threshold | 0.2 | DG(*H) threshold for NRR selectivity (eV) |

---

### Structure Transformation Nodes

All transformation nodes run locally on the server. They modify the input structure and pass the result downstream.

#### Supercell Generation

| Parameter | Default | Description |
|-----------|---------|-------------|
| scaling | 2x2x2 | Supercell expansion factors |

#### Defect Generation

| Parameter | Default | Description |
|-----------|---------|-------------|
| defect_type | vacancy | Type: vacancy, substitution, interstitial |
| site_index | 0 | Atom index for the defect site |
| substitute | — | Replacement element (for substitution) |

Enumerates symmetry-unique sites when multiple defects are possible.

#### Strain / Deformation

| Parameter | Default | Description |
|-----------|---------|-------------|
| strain_type | uniaxial | Type: uniaxial, biaxial, hydrostatic, shear |
| magnitude | 0.02 | Strain magnitude (fractional) |
| scan | false | Scan mode: generate multiple strained structures |
| scan_range | -0.05 to 0.05 | Range for scan mode |

#### Doping

| Parameter | Default | Description |
|-----------|---------|-------------|
| dopant | — | Dopant element |
| host_element | — | Element to replace |

Enumerates symmetry-unique substitution sites.

#### Intercalation

| Parameter | Default | Description |
|-----------|---------|-------------|
| intercalant | Li | Intercalated species (Li, Na, K) |

#### Heterostructure

| Parameter | Default | Description |
|-----------|---------|-------------|
| method | ZSL | Lattice matching algorithm |
| max_area | 200 | Maximum interface area (A^2) |
| max_strain | 0.05 | Maximum allowed strain |

#### Nanotube

| Parameter | Default | Description |
|-----------|---------|-------------|
| n, m | 10, 0 | Chiral indices |

#### Water Solvation

| Parameter | Default | Description |
|-----------|---------|-------------|
| density | 1.0 | Water density (g/cm^3) |
| model | TIP4P | Water model |

#### Passivation

| Parameter | Default | Description |
|-----------|---------|-------------|
| method | pseudo-H | pseudo-hydrogen (fractional Z) or H |

---

### Analysis Nodes

#### DOS Analysis

Extracts d-band center and projected DOS from a parent VASP static calculation.

#### COHP Analysis

Runs LOBSTER for crystal orbital Hamilton population analysis.

#### MD Analysis

| Parameter | Default | Description |
|-----------|---------|-------------|
| analysis | all | Metrics: RMSD, RDF, MSD, density profile, H-bonds |

#### Convergence Check

| Parameter | Default | Description |
|-----------|---------|-------------|
| energy_threshold | 1e-4 | Energy convergence (eV/atom) |
| force_threshold | 0.05 | Maximum force (eV/A) |

Returns pass or fail. Connect to a **Condition** node for branching.

#### Energy Compare

Compares energies across multiple parent calculations. Outputs a ranking table with adsorption energies, surface energies, or formation energies.

#### Charge Analysis

| Parameter | Default | Description |
|-----------|---------|-------------|
| method | bader | Bader or DDEC6 charge analysis |

Runs on HPC (requires Bader executable).

#### Export

| Parameter | Default | Description |
|-----------|---------|-------------|
| format | json | Output format: json, csv, cif, poscar |

---

### Logic Nodes

#### Condition

Branches the workflow based on a criterion.

| Parameter | Default | Description |
|-----------|---------|-------------|
| criterion | energy_diff | What to check: energy_diff, max_force, convergence, n_steps |
| threshold | 0.01 | Threshold value |
| operator | < | Comparison operator |

#### Loop

Iterates over a collection, executing downstream nodes for each item.

| Parameter | Default | Description |
|-----------|---------|-------------|
| iterate_over | structures | What to loop: structures, parameters |

#### Merge

Synchronization barrier. Waits for all incoming edges to complete before continuing. No parameters.

---

## Built-in Templates

| Template | Nodes | Description |
|----------|-------|-------------|
| **Band Structure** | 3 | Relax → Static → DOS analysis |
| **Adsorption Screening** | 5 | Parallel DFT + MLP relaxation, energy comparison |
| **MLP MD Pipeline** | 4 | Structure → MLP MD → MD analysis → Export |
| **Batch Surface** | 5 | Loop surfaces → Relax → Merge → Analyze |
| **Defect Screening** | 6 | Supercell → Defect gen → Loop → Relax → Compare |
| **Heterostructure Study** | 5 | Build interface → Relax → DOS + COHP |

Templates are starting points — you can add, remove, or reconfigure any node after loading.

---

## HPC Execution

### Job Script Presets

| Preset | Scheduler | Description |
|--------|-----------|-------------|
| Generic SLURM | SLURM | Standard SLURM submission script |
| Generic PBS | PBS | For PBS/Torque clusters |
| Shaheen-III | SLURM | KAUST HPC with module loading |

### Resource Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| nodes | 1 | Compute nodes |
| ntasks | 16 | MPI tasks |
| cpus_per_task | 8 | OpenMP threads per task |
| walltime | 02:00:00 | Maximum job duration |
| partition | — | Cluster partition/queue |
| memory | — | Memory per node |
| base_work_dir | ~/calculations | Remote working directory |
| poll_interval | 30s | Job status polling interval |

### Remote Directory Structure

Each step creates a directory on the HPC cluster:

```
~/calculations/
├── vasp_relax_abc12345/
│   ├── INCAR
│   ├── POSCAR
│   ├── KPOINTS
│   ├── POTCAR (user-provided)
│   ├── submit.sh
│   ├── run_custodian.py
│   ├── CONTCAR (output)
│   ├── OUTCAR (output)
│   └── OSZICAR (output)
└── mlp_md_def45678/
    ├── POSCAR
    ├── run_mlp.py
    └── trajectory.xyz (output)
```

### Custodian Error Handling

Custodian is enabled by default and automatically handles common VASP errors:

| Error | Fix Applied | Max Retries |
|-------|-------------|-------------|
| ZBRENT failure | Switch IBRION | 5 |
| EDDDAV/EDWAV | Switch to algo=Normal/Fast | 5 |
| KPOINTS too dense | Reduce mesh | 5 |
| Charge mixing | Adjust AMIX/BMIX | 5 |
| Walltime exceeded | Restart from CONTCAR | 5 |

Disable Custodian in the run configuration if you want raw VASP execution.

---

## Workflow Recovery

The engine persists all state to an SQLite database. Recovery is automatic:

1. On server startup, `recover_workflows()` checks for interrupted workflows
2. Queries HPC clusters for job status
3. Extracts results from jobs that completed while offline
4. Resumes execution from the next pending layer

### Persistence Details

| Data | Storage |
|------|---------|
| Workflow graph | SQLite (`graph_json`) |
| Step status | SQLite (`status`, `started_at`, `completed_at`) |
| HPC job IDs | SQLite (`hpc_job_id`, `hpc_session_id`) |
| Run configuration | SQLite (`WorkflowRunConfig`) |
| DFT results | ASE database (`energy`, `forces`, `structure`) |

---

## API Reference

### Workflow CRUD

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workflow/` | POST | Create a new workflow |
| `/workflow/` | GET | List all workflows |
| `/workflow/{id}` | GET | Get workflow details |
| `/workflow/{id}` | PUT | Update graph, name, or status |
| `/workflow/{id}` | DELETE | Delete a workflow |

### Execution Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workflow/{id}/run` | POST | Start workflow with run config |
| `/workflow/{id}/pause` | POST | Pause execution |
| `/workflow/{id}/resume` | POST | Resume paused workflow |
| `/workflow/{id}/run-status` | GET | Get current execution status |
| `/workflow/{id}/monitor` | WebSocket | Real-time status stream |

### Steps and Results

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workflow/{id}/steps` | GET | List all steps |
| `/workflow/{id}/steps/{step_id}` | PUT | Update step config |
| `/workflow/{id}/steps/{step_id}/files` | GET | List output files |
| `/workflow/{id}/steps/{step_id}/output/{file}` | GET | Download output file |
| `/workflow/{id}/convergence/{step_id}` | GET | OSZICAR convergence data |
| `/workflow/{id}/results` | GET | Get workflow results |
| `/workflow/{id}/results-enriched` | GET | Results with formulas and volumes |

### Templates

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workflow/templates` | GET | List available templates |
| `/workflow/from-template/{id}` | POST | Create workflow from template |
| `/workflow/job-script-presets` | GET | Get job script presets |
