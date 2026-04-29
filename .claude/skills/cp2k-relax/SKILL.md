---
name: cp2k-geo-opt
description: CP2K geometry optimization. Handles bulk, slab, and molecular systems with GPW method. Efficient for large systems (200+ atoms).
---

# CP2K Geometry Optimization

Set up and submit CP2K geometry optimizations using the Gaussian and Plane-Wave (GPW) method. CP2K is the preferred code for systems larger than ~200 atoms where VASP becomes memory-limited.

## Scenario 1: Bulk Optimization

Full cell and ionic relaxation for periodic bulk systems.

```python
from catgo.workflow import Workflow

wf = Workflow("CP2K bulk MgO")
struct = wf.add_task("structure_input", structure=bulk_json)

opt = wf.add_task("geo_opt",
                  structure=struct.output.structure,
                  software="cp2k",
                  cell_opt=True,          # Relax cell + ions (like ISIF=3 in VASP)
                  cutoff=600,             # Ry
                  rel_cutoff=60,          # Ry
                  basis_set="DZVP-MOLOPT-SR-GTH",
                  xc_functional="PBE",
                  max_iter=200,           # Max geo_opt steps
                  eps_geo=3e-4,           # Force convergence (Hartree/Bohr)
                  system_name="bulk_MgO")

wf.submit()
```

**MCP equivalent:**
```
catgo_workflow_v2(action="create", params={"name": "CP2K bulk MgO"})

catgo_workflow_v2(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<bulk_json>"
})

catgo_workflow_v2(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "geo_opt",
  "software": "cp2k",
  "structure": "{{t_001.output.structure}}",
  "cell_opt": true,
  "cutoff": 600,
  "basis_set": "DZVP-MOLOPT-SR-GTH",
  "system_name": "bulk_MgO"
})

catgo_workflow_v2(action="submit", params={"workflow_id": "wf_xxx"})
```

## Scenario 2: Slab Optimization

Fixed cell, ionic relaxation with frozen bottom layers. Analogous to VASP ISIF=2.

```python
wf = Workflow("CP2K TiO2 slab")
struct = wf.add_task("structure_input", structure=slab_json)

opt = wf.add_task("geo_opt",
                  structure=struct.output.structure,
                  software="cp2k",
                  cell_opt=False,         # Fix cell (slab)
                  cutoff=600,
                  basis_set="DZVP-MOLOPT-SR-GTH",
                  freeze_layers=2,        # Freeze bottom 2 layers
                  poisson_solver="MT",    # Martyna-Tuckerman for slab geometry
                  system_name="TiO2_slab")

wf.submit()
```

**Slab-specific settings:**
- `cell_opt=False` — mandatory for slabs (equivalent to ISIF=2 in VASP)
- `freeze_layers=2` — freeze bottom layers to mimic bulk
- `poisson_solver="MT"` — Martyna-Tuckerman solver handles the vacuum correctly for 2D-periodic systems. Use "PERIODIC" for bulk (3D-periodic) and "MT" or "WAVELET" for slabs

## Scenario 3: Adsorbate on Slab

Same as slab, with adsorbate atoms free to relax:

```python
opt = wf.add_task("geo_opt",
                  structure=adsorbate_slab_json,
                  software="cp2k",
                  cell_opt=False,
                  freeze_layers=2,
                  cutoff=600,
                  vdw_method="DFTD3",    # Dispersion for adsorption
                  poisson_solver="MT",
                  system_name="*OH_on_TiO2")
```

## Scenario 4: Large System (500+ atoms)

CP2K's GPW method with OT (Orbital Transformation) SCF solver scales linearly for large systems:

```python
opt = wf.add_task("geo_opt",
                  structure=large_system_json,
                  software="cp2k",
                  cutoff=400,                   # Lower cutoff acceptable for screening
                  basis_set="SZV-MOLOPT-SR-GTH", # Minimal basis for speed
                  ot_minimizer="DIIS",           # OT method for large systems
                  ot_preconditioner="FULL_ALL",
                  eps_scf=1e-5,
                  system_name="large_system")
```

**OT vs diagonalization:**
- OT: O(N) scaling, no HOMO-LUMO gap requirement, default for > 100 atoms
- Diagonalization: O(N^3) scaling, needed for metallic systems (zero gap)

**For metals:** OT does not work for metallic systems (zero band gap). Use Fermi-Dirac smearing with diagonalization:
```python
opt = wf.add_task("geo_opt",
                  structure=metal_json,
                  software="cp2k",
                  scf_method="diag",          # Standard diagonalization
                  smearing_method="FERMI_DIRAC",
                  electronic_temperature=300,  # K
                  system_name="metal")
```

## Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| cutoff | 600 Ry | PW cutoff for density grid |
| rel_cutoff | 60 Ry | Multi-grid relative cutoff |
| basis_set | DZVP-MOLOPT-SR-GTH | Gaussian basis set |
| xc_functional | PBE | Exchange-correlation functional |
| max_iter | 200 | Max geometry optimization steps |
| eps_geo | 3e-4 | Force convergence (Hartree/Bohr, ~ 0.015 eV/A) |
| eps_scf | 1e-6 | SCF convergence (Hartree) |
| cell_opt | False | Whether to optimize cell parameters |
| freeze_layers | 0 | Number of bottom layers to freeze |
| vdw_method | None | Dispersion correction ("DFTD3", "DFTD3(BJ)") |
| poisson_solver | PERIODIC | Poisson solver ("PERIODIC", "MT", "WAVELET") |

## Convergence Monitoring

```
catgo_workflow_v2(action="status", params={"workflow_id": "wf_xxx"})

catgo_analyze(action="convergence", params={"task_id": "t_opt"})
# Returns: energy vs step, max force vs step

catgo_analyze(action="forces", params={"task_id": "t_opt"})
```

## Chain: CP2K Optimization then Frequency

```python
wf = Workflow("CP2K opt + freq")
struct = wf.add_task("structure_input", structure=slab_oh_json)

opt = wf.add_task("geo_opt", structure=struct.output.structure,
                  software="cp2k", freeze_layers=2,
                  system_name="*OH")

frq = wf.add_task("freq", structure=opt.output.structure,
                  software="cp2k",
                  freeze_mode="layers", freeze_layers=4,
                  system_name="*OH")

gib = wf.add_task("gibbs_energy",
                  energy=opt.output.energy,
                  frequencies=frq.output.frequencies,
                  phase="adsorbed", system_name="*OH")

wf.submit()
```

## Output

The geo_opt task produces:
- `output.structure` — optimized structure (pymatgen dict as JSON string)
- `output.energy` — total DFT energy in eV

## Troubleshooting

| Problem | Fix |
|---|---|
| SCF not converging | Use OT method, increase scf_max_iter, reduce mixing |
| Energy oscillations | Increase cutoff (try 800 Ry), check rel_cutoff |
| Forces not converging | Loosen eps_geo, increase max_iter |
| OT fails for metal | Switch to diagonalization with Fermi smearing |
| Memory error | Reduce cutoff, use SZV basis, increase nodes |
| Missing basis for element | Check CP2K basis set library, may need to download |
| Poisson solver error for slab | Use poisson_solver="MT" instead of "PERIODIC" |

## Unit Conversions

CP2K uses atomic units internally. CatGo converts automatically, but for reference:
- 1 Hartree = 27.2114 eV
- 1 Bohr = 0.529177 A
- Force: 1 Ha/Bohr = 51.422 eV/A
- eps_geo=3e-4 Ha/Bohr corresponds to ~0.015 eV/A (comparable to VASP EDIFFG=-0.02)
