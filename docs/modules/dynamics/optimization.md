# Optimization

Structure relaxation and energy calculations using multiple computational backends, with real-time progress streaming.

**Source:** `src/lib/api/compute.ts`, `src/lib/structure/OptimizationPane.svelte`, `server/routers/`

## Available Calculators

| Calculator | Method | Description | Use Case |
|-----------|--------|-------------|----------|
| **EMT** | Effective Medium Theory | Fast empirical potential | Metals (Al, Cu, Ag, Au, Ni, Pd, Pt) |
| **xTB GFN2** | Semi-empirical DFT | Tight-binding with dispersion | Organic molecules, molecular crystals |
| **xTB GFN1** | Semi-empirical DFT | Faster, less accurate than GFN2 | Large organic systems |
| **xTB GFN0** | Semi-empirical | Fastest xTB variant | Screening, pre-optimization |
| **xTB GFN-FF** | Force field | xTB-parameterized force field | Very fast pre-relaxation |
| **MACE** | Machine learning | Equivariant neural network potential | General-purpose, high accuracy |
| **CHGNet** | Machine learning | Crystal Hamiltonian Graph Network | Inorganic materials |
| **M3GNet** | Machine learning | Materials 3-body Graph Network | Inorganic materials |
| **UFF** | Force field (WASM) | Universal Force Field | Quick in-browser optimization |

## Key Functions

### Client-Side (TypeScript)

```typescript
// List available calculators and their status
fetchCalculators(): Promise<Calculator[]>

// Check if server is running
check_server_available(): Promise<boolean>

// HTTP-based optimization (returns final result)
optimize_structure(structure, calculator, options): Promise<OptimizationResult>

// WebSocket streaming (real-time step-by-step updates)
optimize_structure_ws(structure, calculator, options, onStep): Promise<OptimizationResult>

// In-browser UFF optimization via WASM (no server needed)
wasm_optimize_structure(structure): Structure
```

### Server-Side (Python)

The FastAPI server exposes:

- `GET /api/optimize/calculators` — list available calculators
- `POST /api/optimize/structure` — optimize structure (HTTP)
- `GET /api/optimize/ws` — WebSocket streaming optimization
- `GET /api/optimize/energy` — single-point energy calculation

## Optimizer Methods

In addition to choosing a calculator (energy/force engine), you can choose the **optimizer algorithm** that drives the search:

| Optimizer | Type | Description | Use Case |
|-----------|------|-------------|----------|
| **BFGS** | Minimizer | Quasi-Newton local minimizer (ASE default) | Finding stable structures (local minima) |
| **Sella Minimize** | Minimizer | Trust-radius minimizer ([Sella](https://github.com/zadorlab/sella) `order=0`) | Alternative to BFGS, sometimes more robust |
| **Sella TS Search** | Saddle point | Transition state finder ([Sella](https://github.com/zadorlab/sella) `order=1`) | Finding reaction barriers and transition states |
| **IRC** | Reaction path | Intrinsic Reaction Coordinate ([Sella](https://github.com/zadorlab/sella)) | Tracing the minimum energy path from a TS |

::: tip What is a transition state?
A **transition state** (TS) is the highest-energy point along the lowest-energy path between a reactant and product. It tells you the **activation energy** — the energy barrier the system must overcome for a reaction to occur. Sella's TS Search finds these saddle points on the potential energy surface.
:::

### Sella Parameters

When using Sella Minimize or Sella TS Search:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `delta0` (Trust radius) | Initial trust radius for step size control | Auto (Sella default) |

When using IRC:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `dx` (Step size) | IRC step size in Angstrom | Auto (Sella default) |

### Installing Sella

Sella is an optional dependency. The server works without it — BFGS is always available. To enable Sella optimizers:

```bash
# Python 3.13+ requires setuptools-scm first
pip install setuptools-scm

# Install Sella (use --no-build-isolation on Python 3.13+)
pip install --no-build-isolation sella
```

If Sella is not installed and you select a Sella optimizer, the server returns a clear error message with install instructions.

For more details, see the [Sella GitHub repository](https://github.com/zadorlab/sella).

## Optimization Options

| Option | Type | Description |
|--------|------|-------------|
| `calculator` | string | Calculator name (e.g., "mace", "xtb_gfn2") |
| `optimizer` | string | Optimizer algorithm: `bfgs`, `sella_min`, `sella_ts`, `irc` |
| `fmax` | number | Force convergence criterion (eV/A) |
| `max_steps` | number | Maximum optimization steps |
| `optimize_cell` | boolean | Also relax cell shape/volume |
| `frozen_atoms` | number[] | Atom indices to keep fixed |

## Real-Time Progress

WebSocket optimization streams per-step updates:

```typescript
interface OptimizationStep {
  step: number          // Current step number
  energy: number        // Total energy (eV)
  fmax: number          // Maximum force (eV/A)
  structure: Structure  // Current atomic positions
  converged: boolean    // Whether fmax < threshold
}
```

The UI displays:
- Energy convergence plot
- Maximum force (fmax) convergence plot
- Live 3D structure update at each step
- Step counter and status

## Frozen Atoms

Atoms can be marked as "fixed" to exclude them from optimization:

- **Ring indicator** — circular ring around frozen atoms
- **Crosshatch** — patterned overlay
- **Dimmed** — reduced opacity

Frozen atoms are passed as index arrays to the optimizer.

## Components

| Component | Description |
|-----------|-------------|
| `OptimizationPane.svelte` | Calculator selection, options, run/stop controls |
| Energy/force convergence plots | Real-time line plots during optimization |

## Architecture

```
Browser                          Server
┌──────────────┐    HTTP/WS     ┌───────────────────────────┐
│ Optimization │ ──────────────→│ FastAPI Server             │
│ Pane         │                │  ├── Calculators (energy)  │
│              │←────────────── │  │   ├── EMT               │
│ (real-time   │   step data    │  │   ├── xTB               │
│  updates)    │                │  │   ├── MACE              │
└──────────────┘                │  │   ├── CHGNet            │
                                │  │   └── M3GNet            │
                                │  └── Optimizers (search)   │
                                │      ├── BFGS (default)    │
                                │      ├── Sella Minimize    │
                                │      ├── Sella TS Search   │
                                │      └── IRC               │
┌──────────────┐                └───────────────────────────┘
│ WASM (UFF)   │ ← no server needed
└──────────────┘
```
