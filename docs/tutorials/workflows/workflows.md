# Using the Workflow Engine

CatGO's workflow engine lets you build, run, and monitor multi-step computational workflows — from simple DFT relaxations to full catalysis screening pipelines. Workflows are designed as visual node graphs and executed on remote HPC clusters or locally.

## Prerequisites

- CatGO desktop app or web app
- Python backend server running (`cd server && python main.py`)
- For DFT calculations: SSH access to an HPC cluster with VASP installed
- For ML potential calculations: HPC cluster with MACE, CHGNet, or M3GNet

## Opening the Workflow Editor

1. Click the **+** button in the tab bar and select **Workflow**
2. A new workflow tab opens with the visual graph editor

If you already have a workflow tab, click it to switch back.

## Creating Your First Workflow

### Starting from a Template

The fastest way to get started is with a built-in template:

1. Click **Templates** in the workflow toolbar
2. Choose from the available templates:

| Template | Description |
|----------|-------------|
| Band Structure | Relax → Static → Band structure calculation |
| Adsorption Screening | Parallel DFT + MLP relax, compare energies |
| MLP MD Pipeline | Structure → MLP MD → Analysis → Export |
| Batch Surface | Loop over surfaces → Relax → Merge → Analyze |
| Defect Screening | Supercell → Defect generation → Loop → Relax → Compare |
| Heterostructure Study | Build interface → Relax → DOS + COHP analysis |

3. The template graph loads into the editor. You can modify it freely.

### Building from Scratch

1. **Add nodes** — Right-click the canvas or use the node palette to add calculation nodes
2. **Connect nodes** — Drag from an output handle to an input handle to create edges
3. **Configure parameters** — Click any node to open its parameter panel on the right

### Node Types Overview

Nodes are grouped into categories:

**Input:**
- **Structure Input** — Load a structure from file, database, or the editor

**DFT Calculations** (run on HPC):
- **VASP Relax** — Geometry optimization
- **VASP Static** — Single-point energy calculation
- **VASP MD** — Ab initio molecular dynamics
- **Electronic** — DOS, Bader charges, COHP analysis
- **Frequency** — Vibrational analysis and ZPE

**ML Potentials** (run on HPC):
- **MLP Relax** — Fast relaxation with MACE, CHGNet, or M3GNet
- **MLP MD** — Long-timescale molecular dynamics

**Structure Transformations** (run locally):
- **Slab Generation** — Cut surfaces from Miller indices
- **Supercell** — Expand the periodic cell
- **Defect Generation** — Create vacancies, substitutions, interstitials
- **Adsorbate Placement** — Place molecules on surface sites
- **Doping** — Substitutional doping with symmetry enumeration
- **Strain/Deformation** — Uniaxial, biaxial, hydrostatic, shear
- **Heterostructure** — ZSL lattice matching and stacking
- **Nanotube** — Roll 2D sheets into nanotubes
- **Water Solvation** — Add explicit water layers
- **Passivation** — Pseudo-hydrogen on dangling bonds

**Analysis** (run locally):
- **DOS Analysis** — d-band center, projected DOS
- **COHP Analysis** — LOBSTER bonding analysis
- **MD Analysis** — RMSD, RDF, MSD, density profiles
- **Convergence Check** — Verify calculation convergence
- **Energy Compare** — Rank and compare energies
- **Charge Analysis** — Bader or DDEC6 charges
- **Free Energy Diagram** — Reaction pathway thermodynamics
- **Export** — Save results as JSON, CSV, CIF, or POSCAR

**Logic:**
- **Condition** — Branch based on energy, force, or convergence criteria
- **Loop** — Iterate over structures or parameter sweeps
- **Merge** — Wait for all inputs before continuing

## Configuring Node Parameters

Click any node to open its configuration panel. Parameters are grouped by category.

### VASP Relax Example

| Parameter | Default | Description |
|-----------|---------|-------------|
| ENCUT | 520 eV | Plane-wave energy cutoff |
| EDIFF | 1e-5 | Electronic convergence criterion |
| EDIFFG | -0.02 | Ionic convergence (force criterion, eV/A) |
| ISIF | 3 | Stress tensor: 2 = fix cell, 3 = full relax, 4 = fix volume |
| NSW | 200 | Maximum ionic steps |
| IBRION | 2 | Optimizer: 1 = Quasi-Newton, 2 = CG, 3 = FIRE |
| KPOINTS | 4x4x4 | k-point mesh |
| double_relax | false | Run VASP twice (atomate2 pattern) |
| NCORE | 4 | Parallelization cores per band |

### MLP Relax Example

| Parameter | Default | Description |
|-----------|---------|-------------|
| model | MACE-MP | ML potential: MACE-MP, CHGNet, M3GNet |
| fmax | 0.01 | Force convergence criterion (eV/A) |

### Slab Generation Example

| Parameter | Default | Description |
|-----------|---------|-------------|
| Miller indices | (1,1,1) | Surface orientation |
| Layers | 4 | Number of atomic layers |
| Vacuum | 15 A | Vacuum thickness |
| Supercell | 2x2 | In-plane supercell expansion |

## Running a Workflow

### 1. Configure HPC Connection

Before running, you need an active HPC session:

1. Open the **HPC** panel (terminal icon in the sidebar)
2. Connect to your cluster via SSH
3. Note the session name — you'll select it when launching the workflow

### 2. Set Run Configuration

Click **Run** in the workflow toolbar to open the run configuration dialog:

| Setting | Description |
|---------|-------------|
| HPC Session | Select which cluster connection to use |
| Job Script | Choose a preset (SLURM, PBS, Shaheen-III) or write custom |
| Base Directory | Working directory on the cluster (default: `~/calculations`) |
| Nodes | Number of compute nodes |
| Tasks | Number of MPI tasks |
| CPUs/Task | OpenMP threads per task |
| Walltime | Maximum job duration (HH:MM:SS) |
| Custodian | Enable automatic error handling (recommended) |

### 3. Launch

Click **Start** to begin execution. The workflow engine:

1. Sorts nodes into execution layers (topological order)
2. Executes each layer — nodes in the same layer run in parallel
3. For HPC nodes: generates input files, submits jobs, polls for completion
4. For local nodes: executes immediately on the server
5. Passes results (structures, energies) downstream to dependent nodes

### Job Script Presets

| Preset | Scheduler | Notes |
|--------|-----------|-------|
| Generic SLURM | SLURM | Works on most SLURM clusters |
| Generic PBS | PBS | For PBS/Torque clusters |
| Shaheen-III | SLURM | KAUST-specific with module loading |

You can customize any preset or write your own job script template.

## Monitoring Execution

Once a workflow is running, the editor shows real-time status:

| Status | Color | Meaning |
|--------|-------|---------|
| Pending | Gray | Waiting for dependencies |
| Queued | Purple | Job submitted, waiting in scheduler queue |
| Running | Blue | Actively computing |
| Completed | Green | Finished successfully |
| Failed | Red | Error occurred |
| Skipped | Gray | Skipped due to upstream failure |

### Workflow Controls

| Action | Description |
|--------|-------------|
| **Pause** | Suspend execution (running jobs continue, new ones don't start) |
| **Resume** | Continue from where you paused |
| **Cancel** | Stop the workflow and mark as failed |

### Checking Job Output

Click a completed node to see its results:

- **Energy** — Total energy, energy per atom
- **Forces** — Maximum force, force convergence
- **Structure** — Output structure (CONTCAR)
- **Files** — Download OUTCAR, OSZICAR, vasprun.xml, etc.
- **Convergence** — OSZICAR energy vs. ionic step plot

## Viewing Results

### Results Dashboard

Open the **Project Dashboard** to see all workflow results in one place:

- **Table view** — Sortable columns: formula, energy, energy/atom, volume, node type
- **Plot view** — Scatter or bar charts for energy comparisons
- **Filter** — By formula, node type, or workflow name
- **Export** — Download results as JSON or CSV

### ASE Database

All completed DFT and MLP calculations are automatically stored in an ASE database with metadata:

- Workflow ID and step ID
- Node type (vasp_relax, mlp_md, etc.)
- Energy, forces, stress
- Atomic structure

You can query the database from the project dashboard or directly via the ASE Python API.

## Custodian Error Handling

When enabled (recommended), Custodian automatically handles common VASP errors:

| Error | Automatic Fix |
|-------|---------------|
| ZBRENT failure | Restart with different IBRION |
| EDDDAV/EDWAV | Switch to algo=Normal/Fast |
| KPOINTS too dense | Reduce mesh |
| Charge mixing issues | Adjust AMIX/BMIX |
| Walltime exceeded | Automatic restart from CONTCAR |

Custodian retries up to 5 times (configurable) before marking a step as failed.

## Example Workflows

### Band Structure Calculation

```
Structure Input → VASP Relax → VASP Static (dense k-grid) → DOS Analysis
```

1. Add a **Structure Input** node and load your crystal
2. Connect to a **VASP Relax** node (ISIF=3 for full cell relaxation)
3. Connect to a **VASP Static** node with ISMEAR=-5 (tetrahedron method) and NEDOS=3001
4. Connect to a **DOS Analysis** node to extract the d-band center

### Surface Catalysis (NRR) Pipeline

```
Structure Input
    → Bulk Opt (9x9x9 k-grid, ISIF=3)
    → Slab Gen (111, 4 layers, 15A vacuum)
    → Slab Relax (ISIF=2, freeze bottom layers)
    → Loop: Adsorbate sites (ontop, bridge, fcc, hcp)
        → Slab Relax → Frequency
    → Merge
    → Reference Molecules (N2, H2, NH3)
    → Free Energy Diagram
```

This calculates adsorption energies, ZPE corrections, and generates a free energy diagram for the nitrogen reduction reaction.

### Defect Screening

```
Structure Input
    → Supercell (2x2x2)
    → Defect Gen (vacancy)
    → Loop: Each defect site
        → VASP Relax
    → Merge
    → Energy Compare
```

Enumerates unique vacancy sites, relaxes each, and ranks by formation energy.

## Workflow Recovery

The workflow engine automatically saves state to the database. If the server crashes or restarts:

1. On startup, the engine checks for incomplete workflows
2. Queries the HPC cluster for job status
3. If jobs completed while the server was down, results are extracted
4. The workflow resumes from the next pending layer

No manual intervention is needed — recovery is fully automatic.

## Next Steps

- [Workflow Node Reference](/modules/workflow/workflow-engine) — Detailed parameters for every node type
- [Structure Optimization](/tutorials/structures/optimization) — Local optimization without workflows
- [Desktop App](/tutorials/desktop/desktop-app) — Tab management and HPC terminal
- [FAQ](/reference/faq#workflows) — Common workflow questions and troubleshooting
