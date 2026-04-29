---
name: computational-input
description: >
  Use when the user asks to generate DFT input files (VASP, Quantum ESPRESSO, LAMMPS),
  optimize structures with ML potentials (MACE, CHGNet, M3GNet), compute energy,
  or set up any computational chemistry calculation.
---

# Computational Input Generation

## Quick Decision Guide

| Task | Tool |
|------|------|
| VASP input (INCAR/POSCAR/KPOINTS) | `catgo_vasp_generate` |
| Quantum ESPRESSO pw.x input | `catgo_qe_generate` |
| LAMMPS input + data file | `catgo_lammps_generate` |
| Multi-stage LAMMPS simulation | `catgo_lammps_sequential` |
| ML potential relaxation | `catgo_optimize` |
| Single-point energy/forces | `catgo_energy` |
| List available calculators | `catgo_calculators` |

## VASP Input

### `catgo_vasp_generate`
- **Calculation types**: `opt`, `scf`, `freq`, `bader`, `dos`, `ddec`, `elf`
- **Key params**: `encut` (default 450 eV), `gga` ("PE"=PBE), `ispin` (2=spin-polarized),
  `ivdw` (12=D3-BJ), `kspacing`, `fixed_indices`/`fixed_z_below`

**Common patterns**:
- Bulk optimization: `calculation_type="opt"`, `isif=3` (relax cell+ions)
- Slab optimization: `calculation_type="opt"`, `isif=2`, `fixed_z_below=Z`
- DOS: `calculation_type="dos"`, dense k-mesh

Call `catgo_vasp_calc_types` to list all available types with defaults.

## Quantum ESPRESSO Input

### `catgo_qe_generate`
- **Calculation types**: `scf`, `relax`, `vc-relax`, `nscf`, `bands`
- **Key params**: `ecutwfc` (default 60 Ry), `ecutrho` (default 480 Ry),
  `kspacing`, `occupations`, `smearing` ("mv"=Marzari-Vanderbilt), `nspin`

Call `catgo_qe_templates` for recommended settings per calculation type.

## LAMMPS Input

### `catgo_lammps_generate`
- **Simulation types**: `minimize`, `nve`, `nvt`, `npt`
- **Key params**: `pair_style`, `pair_coeff`, `potential_file`, `temperature`, `pressure`

### `catgo_lammps_sequential` — Multi-stage MD protocol:
```json
{"stages": [
  {"name": "minimize", "simulation_type": "minimize"},
  {"name": "heat", "simulation_type": "nvt", "temperature": 300, "run_steps": 10000},
  {"name": "equilibrate", "simulation_type": "npt", "temperature": 300, "run_steps": 50000},
  {"name": "production", "simulation_type": "nvt", "temperature": 300, "run_steps": 100000}
]}
```

Call `catgo_lammps_pair_styles` for available force fields.
Call `catgo_lammps_validate` before generating to check configuration.

## ML Potential Optimization

### `catgo_optimize`
Quick relaxation using ML interatomic potentials:
- `mace`: Best accuracy for most systems
- `chgnet`: Good for oxides
- `m3gnet`: General purpose
- `emt`: Fast, metals only (testing)

Params: `fmax` (default 0.05 eV/A), `max_steps` (200), `relax_cell` (True to relax lattice)

### `catgo_energy` — Single-point energy + forces without optimization.

## Workflow Recipes

### ML Pre-Optimization then DFT
1. `catgo_optimize(calculator="mace", fmax=0.05)` → 2. `catgo_vasp_generate(calculation_type="opt")`

### VASP Slab Calculation
1. Build slab → 2. `catgo_vasp_generate(calculation_type="opt", isif=2, fixed_z_below=Z, encut=520)`
