# Structure Optimization

This tutorial covers relaxing atomic positions (and optionally the cell) using local or server-side calculators.

## Overview

CatGO supports two optimization modes:

| Mode | Calculator | Runs In | Network Required |
|------|-----------|---------|-----------------|
| **Local** | UFF (Universal Force Field), VSEPR | Browser (WASM) | No |
| **Server** | EMT, xTB, MACE, CHGNet, M3GNet | Python backend | Yes |

Server mode supports multiple **optimizer algorithms**:

| Optimizer | Purpose | Requires |
|-----------|---------|----------|
| **BFGS** | Find local energy minima (default) | ASE (included) |
| **Sella Minimize** | Alternative minimizer with trust-radius control | [Sella](https://github.com/zadorlab/sella) |
| **Sella TS Search** | Find transition states (saddle points) | [Sella](https://github.com/zadorlab/sella) |
| **IRC** | Trace reaction path from a transition state | [Sella](https://github.com/zadorlab/sella) |

## Local Optimization (UFF)

The UFF optimizer runs entirely in the browser via WebAssembly. No server setup required.

### Steps

1. Load a structure
2. Click the **Optimize** button in the toolbar
3. Select **Local (UFF)** as the optimizer type
4. Set convergence parameters:
   - **fmax** — Force convergence threshold (default: 0.05 eV/A)
   - **Max steps** — Maximum optimization steps (default: 100)
5. Click **Start**

UFF is fast but only suitable for rough geometry optimization. For production calculations, use server-side ML potentials.

## Server Optimization (ML Potentials)

Server-side optimization provides access to accurate machine learning potentials.

### Server Setup

Start the Python computation server:

```bash
cd server
pip install -r requirements.txt
python main.py
```

The server runs on `http://localhost:8000`. CatGO auto-detects the server and shows a green status indicator when connected.

### Available Calculators

| Calculator | Best For | Speed | Accuracy |
|-----------|---------|-------|----------|
| **EMT** | Simple metals (Cu, Ag, Au, Ni, Pd, Pt, Al) | Very fast | Limited elements |
| **xTB** | Molecules and organic systems | Fast | Good for organics |
| **MACE** | General materials | Medium | High |
| **CHGNet** | Inorganic crystals | Medium | High |
| **M3GNet** | General materials | Medium | Good |

### xTB Methods

When using xTB, you can select the method:

| Method | Description |
|--------|-------------|
| GFN2-xTB | Most accurate (default) |
| GFN1-xTB | Faster, slightly less accurate |
| GFN0-xTB | Fastest, least accurate |
| GFN-FF | Force field approximation |
| IPEA1-xTB | Modified parameters for ionization potentials |

### MACE Models

When using MACE, you can select the model size:

| Model | Description |
|-------|-------------|
| small | Fastest, lower accuracy |
| medium | Balanced (default) |
| large | Most accurate, slowest |

Custom model paths are supported for user-trained MACE models.

### Steps

1. Ensure the server is running (`python main.py` in the `server/` directory)
2. Load a structure
3. Click **Optimize** (zap icon) in the toolbar
4. Select **Server (ML Potentials)** and choose a calculator
5. Choose an **Optimizer Method**:
   - **BFGS** — Standard minimizer (default, finds local minima)
   - **Sella Minimize** — Alternative minimizer with trust-radius control
   - **Sella TS Search** — Find transition states (saddle points)
   - **IRC** — Trace the reaction path from a transition state
6. Set parameters:
   - **fmax** — Force convergence (default: 0.05 eV/A)
   - **Max steps** — Maximum iterations (default: 100)
   - **Optimize cell** — Enable to relax lattice parameters (periodic systems only)
7. Click **Optimize**

## Real-Time Progress

During optimization, CatGO shows:

- **Energy chart** — Live SVG plot of energy vs. step
- **Step counter** — Current step / max steps
- **Current energy** — Total energy in eV
- **Current fmax** — Maximum force in eV/A
- **3D structure** — Updates in real-time as atoms move

Progress is streamed via WebSocket for smooth updates.

## Selective Dynamics (Freezing Atoms)

You can freeze atoms to prevent them from moving during optimization:

1. **Select atoms** you want to freeze (click or Shift+click)
2. Mark them as **frozen** via the context menu or controls
3. Frozen atoms display a visual indicator (ring, crosshatch, or dimmed — configurable in settings)
4. Start optimization — frozen atoms remain fixed

This is useful for:
- Surface slab calculations (freeze bottom layers)
- Defect studies (freeze bulk, relax near defect)
- Adsorbate optimization (freeze substrate)

### Fragment Extraction

When atoms are selected before starting optimization, you can choose to:
- **Fix unselected atoms** — Optimize only selected atoms in place
- **Extract fragment** — Pull selected atoms into an isolated molecule for optimization, then merge back

## Transition State Search with Sella

[Sella](https://github.com/zadorlab/sella) is a saddle point optimizer that integrates with ASE. It enables finding transition states and tracing reaction paths — capabilities that BFGS cannot provide.

### Installing Sella

Sella is optional. Install it in your server environment:

```bash
pip install setuptools-scm                  # needed on Python 3.13+
pip install --no-build-isolation sella
```

If Sella is not installed, the BFGS optimizer is always available and CatGO will show a clear error if you try to use a Sella optimizer.

### Finding a Transition State

1. Start with a structure near the expected transition state (e.g., an atom midway through a migration)
2. Open the optimization pane → **Server** mode
3. Select your calculator (e.g., **MACE** or **EMT**)
4. Set **Optimizer Method** to **Sella TS Search**
5. Click **Optimize**

The TS search will move the structure **uphill** in energy toward the saddle point. When converged, you have the transition state geometry and can read the activation energy from the final energy.

::: tip
Unlike minimization where energy decreases, a TS search typically increases the energy — this is expected. The optimizer is looking for a point where forces vanish but the structure is at a maximum along one direction (the reaction coordinate) and a minimum along all others.
:::

### Tracing the Reaction Path (IRC)

Once you have a transition state, use IRC to trace the minimum energy path:

1. Load the transition state geometry
2. Set **Optimizer Method** to **IRC**
3. Optionally set the **Step size (dx)** — smaller values give smoother paths
4. Click **Optimize**

IRC follows the steepest descent path from the TS toward the nearest minimum, giving you the reaction pathway.

### Sella Parameters

- **Trust radius** (Sella Minimize / TS Search) — Controls the maximum step size. Smaller values are more conservative but slower. Leave empty to use Sella's default.
- **Step size dx** (IRC) — The IRC step size in Angstrom. Smaller values trace a smoother path but take more steps.

## Exporting Results

After optimization completes:

- **Save structure** — Export the final optimized structure as extXYZ
- **Save trajectory** — Export the full optimization path (all steps) as multi-frame extXYZ with energy metadata

The trajectory export is useful for verifying convergence and creating energy pathway visualizations.

## Cancellation

Click **Cancel** at any time to stop the optimization. The structure reverts to its last completed step.

## Troubleshooting

**Server not detected**
Ensure the Python server is running on port 8000. Check the terminal for errors. The health endpoint is `http://localhost:8000/health`.

**Calculator not available**
Some calculators require additional Python packages. Check the server terminal output for missing dependencies.

**Optimization not converging**
Try increasing `max_steps`, loosening `fmax`, or using a different calculator. For metallic systems, EMT may converge faster than ML potentials.

**"Element not supported" error**
Each calculator supports a specific set of elements. EMT only supports certain metals. xTB works for most organic elements. MACE and CHGNet cover most of the periodic table.

**"Sella is not installed" error**
Sella is an optional dependency. Install it with:
```bash
pip install setuptools-scm              # Python 3.13+ only
pip install --no-build-isolation sella
```

**TS Search not converging**
Transition state searches are more sensitive to the starting geometry than minimizations. Try starting closer to the expected TS geometry, or increase `max_steps`. A good initial guess is critical for TS searches.
