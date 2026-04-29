---
name: siesta
description: >
  Generate and manage SIESTA DFT calculations. Use when the user requests
  SIESTA, numeric atomic orbital (NAO) DFT, or linear-scaling DFT for large systems.
compatibility: >
  Requires SIESTA installed on the HPC target. Pseudopotential files (.psf or .psml)
  must be available for all elements.
---

# SIESTA

## When to Use

- User explicitly requests SIESTA
- User needs linear-scaling O(N) DFT for very large systems (1000+ atoms)
- User wants numeric atomic orbital (NAO) basis sets
- User needs TDDFT or electron transport (TranSIESTA)

## Prerequisites

1. SIESTA binary accessible on HPC (`siesta --version`)
2. Pseudopotentials available (.psf or .psml format)
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "SIESTA relaxation"})
```

### 3. Add SIESTA task via shell

CatGo does not yet have a native SIESTA engine. Use `task_type: "shell"`.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "siesta_relax",
  "command": "siesta < input.fdf > siesta.out 2>&1",
  "input_files": {
    "input.fdf": "<FDF input content>",
    "Si.psf": "{{pseudo_dir}}/Si.psf"
  },
  "system_name": "Si_bulk"
})
```

When a `@register_engine("siesta")` is added, use `task_type: "geo_opt"` with `software: "siesta"`.

## Input File Template — SCF

```
SystemName    TiO2_rutile
SystemLabel   tio2

NumberOfAtoms   <natoms>
NumberOfSpecies <nspecies>

%block ChemicalSpeciesLabel
  1  22  Ti
  2   8  O
%endblock ChemicalSpeciesLabel

PAO.BasisSize     DZP
PAO.EnergyShift   100 meV

LatticeConstant   1.0 Ang
%block LatticeVectors
  <a1x> <a1y> <a1z>
  <a2x> <a2y> <a2z>
  <a3x> <a3y> <a3z>
%endblock LatticeVectors

AtomicCoordinatesFormat Ang
%block AtomicCoordinatesAndAtomicSpecies
  <x> <y> <z>  <species_index>
%endblock AtomicCoordinatesAndAtomicSpecies

# Mesh and K-points
MeshCutoff        300 Ry
%block kgrid_Monkhorst_Pack
  <k1>  0  0  0.0
  0  <k2>  0  0.0
  0  0  <k3>  0.0
%endblock kgrid_Monkhorst_Pack

# SCF
MaxSCFIterations  200
DM.MixingWeight   0.1
DM.Tolerance      1.0d-4
XC.functional     GGA
XC.authors        PBE

# Electronic temperature
ElectronicTemperature  300 K
```

## Relaxation Parameters

Add for geometry optimization:

```
MD.TypeOfRun      CG           # Conjugate gradient
MD.NumCGsteps     200
MD.MaxForceTol    0.02 eV/Ang
MD.VariableCell   .false.      # .true. for bulk cell optimization
```

For slabs, constrain atoms via `%block GeometryConstraints`.

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| PAO.BasisSize | SZ / DZ / DZP / TZP | Single/double/triple-zeta + polarization |
| PAO.EnergyShift | 50-200 meV | Basis confinement; lower = more diffuse, more accurate |
| MeshCutoff | 200-400 Ry | Real-space grid fineness; 300 Ry usually sufficient |
| DM.MixingWeight | 0.05-0.3 | SCF mixing; lower for metals/difficult convergence |
| DM.Tolerance | 1.0d-4 | Density matrix convergence criterion |
| MaxSCFIterations | 200 | Increase for difficult systems |

## Common Pitfalls

1. **MeshCutoff in Ry, not eV** — 300 Ry = 4082 eV. Do not confuse with plane-wave cutoff.
2. **Basis set quality** — SZ is fast but inaccurate; DZP is the practical minimum for publishable results
3. **Ghost atoms** — PAO.EnergyShift too large can cause basis-set superposition error (BSSE)
4. **Pseudopotential format** — use .psf (Siesta native) or .psml (PSML standard). Not UPF.
5. **Linear scaling** — enable with `SolutionMethod OrderN` only for >1000 atoms with a gap. Metals need diagonalization.
6. **Coordinate format** — verify `AtomicCoordinatesFormat` matches your data (Ang vs Fractional vs Bohr)
7. **Memory for diagonalization** — large systems with `SolutionMethod diagon` need significant memory; consider OrderN or parallelization
