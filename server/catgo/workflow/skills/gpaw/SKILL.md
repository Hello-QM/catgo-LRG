---
name: gpaw
description: >
  Generate and manage GPAW Python-based DFT calculations. Use when the user requests
  GPAW, Python DFT, real-space grid DFT, or LCAO-DFT with ASE integration.
compatibility: >
  Requires GPAW and ASE installed in the Python environment on the HPC target.
  PAW datasets must be installed (gpaw install-data).
---

# GPAW (Python DFT)

## When to Use

- User explicitly requests GPAW
- User wants tight ASE integration (optimize with ASE, calculate with GPAW)
- User needs real-space grid, LCAO, or plane-wave modes in a single code
- User wants Python-scripted DFT workflows (no input files, pure Python)

## Prerequisites

1. GPAW + ASE installed on HPC (`gpaw --version`, `python -c "import gpaw"`)
2. PAW datasets installed (`gpaw install-data`)
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "GPAW PBE relaxation"})
```

### 3. Add GPAW task via shell script

CatGo does not yet have a native GPAW engine. Use `task_type: "shell"` with a Python script.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "gpaw_relax",
  "command": "python gpaw_relax.py",
  "input_files": {
    "gpaw_relax.py": "<script content>",
    "structure.json": "<pymatgen dict>"
  },
  "system_name": "TiO2_relax"
})
```

When a `@register_engine("gpaw")` is added to CatGo, use `task_type: "geo_opt"` with `software: "gpaw"` instead.

## Script Template — SCF

```python
from ase.io import read
from gpaw import GPAW, PW

atoms = read('structure.json')

calc = GPAW(
    mode=PW(500),            # Plane-wave mode, 500 eV cutoff
    xc='PBE',
    kpts={'density': 3.0},   # ~0.03 A^-1 k-point density
    txt='gpaw_scf.txt',
    occupations={'name': 'fermi-dirac', 'width': 0.05},
    convergence={'energy': 1e-5},
)

atoms.calc = calc
energy = atoms.get_potential_energy()
print(f'Total energy: {energy:.6f} eV')
```

## Script Template — Relaxation

```python
from ase.io import read, write
from ase.optimize import BFGS
from ase.constraints import FixAtoms
from gpaw import GPAW, PW

atoms = read('structure.json')

# Freeze bottom layers for slabs
c = FixAtoms(indices=[i for i, a in enumerate(atoms)
                      if a.position[2] < atoms.cell[2][2] * 0.4])
atoms.set_constraint(c)

calc = GPAW(
    mode=PW(500),
    xc='PBE',
    kpts={'density': 3.0},
    txt='gpaw_relax.txt',
    convergence={'energy': 1e-5},
)
atoms.calc = calc

opt = BFGS(atoms, trajectory='relax.traj', logfile='relax.log')
opt.run(fmax=0.02)

write('CONTCAR.vasp', atoms)
```

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| mode | PW(500) | Plane-wave cutoff in eV; PW(600) for accurate forces |
| mode | LCAO(dzp) | LCAO mode for large systems (1000+ atoms) |
| xc | 'PBE' | Also: 'RPBE', 'BEEF-vdW', 'mBEEF' |
| kpts | {'density': 3.0} | Auto k-mesh; higher = denser |
| convergence | {'energy': 1e-5} | In eV; tighten for phonon calcs |
| occupations | fermi-dirac, 0.05 | Smearing width in eV |
| parallel | {'domain': 2, 'band': 2} | Domain decomposition for MPI |

## Calculation Modes

| Mode | Best for | Speed |
|---|---|---|
| PW (plane-wave) | Accurate bulk/surface | Moderate |
| LCAO | Large systems, screening | Fast |
| FD (finite-difference) | Real-space, nanostructures | Slow but flexible |

## Common Pitfalls

1. **Forgetting `txt` parameter** — without it, GPAW writes no log and debugging is impossible
2. **LCAO basis not installed** — run `gpaw install-data` with `--basis` flag
3. **Memory for large PW calculations** — GPAW PW mode stores wavefunctions in memory; use LCAO for >500 atoms
4. **No restart file** — add `calc.write('checkpoint.gpw')` after SCF for restart capability
5. **Parallel decomposition mismatch** — `domain * band * kpt` must equal total MPI ranks
6. **Slab k-points** — use `kpts={'size': (N, N, 1)}` to avoid k-points along vacuum direction
