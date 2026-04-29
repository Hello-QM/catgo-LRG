---
name: vasp-md
description: Ab initio molecular dynamics (AIMD) with VASP. NVT/NVE ensembles, temperature control, trajectory analysis.
---

# VASP Ab Initio Molecular Dynamics (AIMD)

Run Born-Oppenheimer molecular dynamics with DFT forces at each step. Expensive but provides finite-temperature behavior, diffusion coefficients, and reaction dynamics.

## When to Use

1. **Thermal stability** — check if a structure is stable at operating temperature
2. **Diffusion** — compute diffusion coefficients (e.g., Li-ion conductors)
3. **Reaction dynamics** — observe bond breaking/forming at finite temperature
4. **Free energy sampling** — metadynamics or thermodynamic integration
5. **Amorphous structures** — melt-quench to generate amorphous phases

## Basic NVT Molecular Dynamics

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, md

wf = Workflow("AIMD at 600K")
struct = wf.add_task("structure_input", structure=structure_json)

# Optional: relax first
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  system_name="relax")

# NVT MD at 600 K
run = wf.add_task(md, structure=opt.output.structure,
                  IBRION=0,      # Molecular dynamics
                  NSW=5000,      # Number of MD steps
                  POTIM=1.0,     # Time step in fs
                  TEBEG=600,     # Starting temperature (K)
                  TEEND=600,     # Ending temperature (K)
                  SMASS=0,       # Nose-Hoover thermostat (NVT)
                  ISIF=2,        # Fix cell shape/volume
                  system_name="AIMD_600K")

wf.submit()
```

## MCP Workflow

```
catgo_workflow_engine(action="create", params={"name": "AIMD 600K"})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<json>"
})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "md",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "NSW": 5000,
  "POTIM": 1.0,
  "TEBEG": 600,
  "TEEND": 600,
  "SMASS": 0,
  "system_name": "AIMD_600K"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| IBRION | 0 | Molecular dynamics mode |
| NSW | 1000 | Number of MD steps |
| POTIM | 1.0 | Time step in femtoseconds |
| TEBEG | 300 | Initial temperature (K) |
| TEEND | 300 | Final temperature (K). Set equal to TEBEG for isothermal |
| SMASS | -1 | Thermostat: -1=NVE, 0=Nose-Hoover NVT, >0=Nose mass |
| ISIF | 2 | Fix cell (NVT). Use ISIF=3 for NPT (rare in AIMD) |
| NBLOCK | 1 | Write trajectory every NBLOCK steps |

## Thermostat Selection (SMASS)

| SMASS | Ensemble | Use case |
|---|---|---|
| -1 | NVE (microcanonical) | Energy conservation test, short dynamics |
| 0 | NVT Nose-Hoover | Standard production MD at fixed T |
| 1-3 | NVT with Nose mass | Larger SMASS = slower T coupling (less perturbation) |
| -3 | Langevin thermostat | Better T control for small systems |

**Recommendation:** Use `SMASS=0` (Nose-Hoover) for most production runs. Use `SMASS=-1` (NVE) for energy conservation checks and very short equilibration diagnostics.

## Temperature Ramp (Heating/Cooling)

To heat from 300 K to 1500 K (simulated annealing or melt-quench):

```python
run = wf.add_task(md, structure=s,
                  NSW=10000,
                  POTIM=2.0,
                  TEBEG=300,     # Start at 300 K
                  TEEND=1500,    # Ramp to 1500 K
                  SMASS=0,
                  system_name="heating_ramp")
```

## Time Step Selection (POTIM)

| System | Recommended POTIM (fs) | Reason |
|---|---|---|
| Heavy elements (Pt, Au, Ru) | 2.0 | Heavy atoms, slow dynamics |
| Oxides (TiO2, RuO2) | 1.0-1.5 | O is light, moderate step needed |
| Light elements (H, Li) | 0.5-1.0 | Fast H vibrations need small step |
| Proton transfer | 0.5 | H requires fine time resolution |

**Rule of thumb:** if the total energy drifts upward in NVE, reduce POTIM.

## Performance Settings

AIMD is expensive. Optimize performance:

```python
run = wf.add_task(md, structure=s,
                  NSW=5000,
                  POTIM=1.0,
                  TEBEG=600,
                  SMASS=0,
                  # Performance
                  ALGO="VeryFast",    # Fastest SCF convergence per step
                  NELM=60,            # Limit SCF steps (MD does not need tight SCF)
                  EDIFF=1e-4,         # Looser SCF for MD (still accurate forces)
                  LREAL="Auto",       # Real-space projection for speed
                  LWAVE=False,        # Do not write WAVECAR each step
                  NCORE=4,
                  system_name="AIMD")
```

**EDIFF=1e-4 is acceptable for MD.** Forces at 1e-4 SCF convergence are sufficiently accurate for MD trajectories. This saves 30-50% compute time vs 1e-5.

## Supercell Size

AIMD requires large enough supercells to avoid finite-size effects:

- **Minimum:** 64-100 atoms for bulk liquids/diffusion
- **Surfaces:** use the slab supercell (typically 2x2 or 3x3 surface unit cell)
- **Small molecules on surface:** existing slab supercell is usually fine

Build a supercell before MD:
```
catgo_structure(action="supercell", params={"scaling": [2, 2, 1]})
```

## Output

The md task produces:
- `output.trajectory` — atomic positions at each step (XDATCAR)
- `output.energy` — energy vs time

## Monitoring a Running MD

```
catgo_workflow_engine(action="status", params={"workflow_id": "wf_xxx"})
# Check NSW progress, temperature stability

catgo_analyze(action="convergence", params={"task_id": "t_md"})
# Energy vs step, temperature vs step
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Temperature explodes | Reduce POTIM, check initial structure for overlapping atoms |
| Energy drift in NVE | Reduce POTIM, tighten EDIFF to 1e-5 |
| SCF not converging at each step | Use ALGO=VeryFast, increase NELM |
| Too slow | Reduce ENCUT (400 eV ok for MD), use LREAL=Auto, fewer k-points |
| Atoms evaporating from slab | Add more vacuum, or constrain bottom layers |

## Typical Simulation Lengths

| Purpose | NSW | POTIM | Total time |
|---|---|---|---|
| Quick stability check | 1000 | 1.0 | 1 ps |
| Equilibration | 5000 | 1.0 | 5 ps |
| Production (diffusion) | 20000-50000 | 1.0-2.0 | 20-100 ps |
| Melt-quench | 10000+ | 2.0 | 20+ ps |
