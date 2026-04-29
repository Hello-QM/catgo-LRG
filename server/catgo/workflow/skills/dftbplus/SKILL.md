---
name: dftbplus
description: >
  Generate and manage DFTB+ calculations. Use when the user requests DFTB+,
  tight-binding DFT, SCC-DFTB, or needs fast approximate DFT for large systems or MD.
compatibility: >
  Requires DFTB+ installed on the HPC target. Slater-Koster parameter files
  must be available (e.g., 3ob, matsci, mio sets from dftb.org).
---

# DFTB+

## When to Use

- User explicitly requests DFTB+ or tight-binding DFT
- User needs fast DFT-level calculations for large systems (1000-10000 atoms)
- User wants SCC-DFTB molecular dynamics at DFT accuracy
- User needs a quick pre-screening before expensive DFT
- User has Slater-Koster parameters available for the elements of interest

## Prerequisites

1. DFTB+ binary accessible on HPC (`dftb+ --version`)
2. Slater-Koster files available (3ob for organic/bio, matsci for inorganic, mio for general)
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`
4. Confirm SK parameter coverage for all elements in the structure

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "DFTB+ optimization"})
```

### 3. Add DFTB+ task via shell

CatGo does not yet have a native DFTB+ engine. Use `task_type: "shell"`.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "dftb_relax",
  "command": "dftb+ > dftb.out 2>&1",
  "input_files": {
    "dftb_in.hsd": "<HSD input content>",
    "geo.gen": "<geometry in GEN format>"
  },
  "system_name": "MoS2_relax"
})
```

When a `@register_engine("dftbplus")` is added, use `task_type: "geo_opt"` with `software: "dftbplus"`.

## Input File Template — SCC-DFTB SCF

```
Geometry = GenFormat {
  <<< geo.gen
}

Driver = {}

Hamiltonian = DFTB {
  Scc = Yes
  SccTolerance = 1e-5
  MaxSccIterations = 200

  SlaterKosterFiles = Type2FileNames {
    Prefix = "/path/to/skfiles/3ob-3-1/"
    Separator = "-"
    Suffix = ".skf"
  }

  MaxAngularMomentum {
    Ti = "d"
    O  = "p"
  }

  KPointsAndWeights = SupercellFolding {
    <k1> 0 0
    0 <k2> 0
    0 0 <k3>
    0.0 0.0 0.0
  }

  Filling = Fermi {
    Temperature [K] = 300
  }
}

Options {
  WriteDetailedOut = Yes
}

Analysis {
  CalculateForces = Yes
}
```

## Relaxation Input

Replace `Driver = {}` with:

```
Driver = ConjugateGradient {
  MaxForceComponent = 1e-3   # Ha/Bohr (~0.05 eV/Ang)
  MaxSteps = 500
  LatticeOpt = No            # Yes for bulk cell optimization
}
```

## GEN Format (Geometry File)

```
<natoms> S                    # S=supercell (periodic), C=cluster
Ti O                          # Element labels
1  1  0.000  0.000  0.000     # index, type, x, y, z (Angstrom or Bohr)
2  2  1.479  1.479  0.000
0.0 0.0 0.0                   # Origin
<a1x> <a1y> <a1z>             # Lattice vectors (only for S type)
<a2x> <a2y> <a2z>
<a3x> <a3y> <a3z>
```

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| SccTolerance | 1e-5 | SCC charge convergence; tighten for forces |
| MaxAngularMomentum | Per element | Must match SK files (s/p/d/f) |
| SlaterKosterFiles | 3ob / matsci / mio | Check element coverage at dftb.org |
| MaxForceComponent | 1e-3 Ha/Bohr | ~0.05 eV/Ang; 1e-4 for high accuracy |
| Filling Temperature | 300 K | Electronic smearing; increase for metals |

## Slater-Koster Parameter Sets

| Set | Elements | Best for |
|---|---|---|
| 3ob-3-1 | H, C, N, O, S, P, Zn, ... | Organic, biochemistry |
| matsci-0-3 | Si, Ge, C, ... | Semiconductors, materials |
| mio-1-1 | H, C, N, O, S, P | General organic |
| tiorg-0-1 | Ti, C, H, N, O, S | TiO2 + organics |

## Common Pitfalls

1. **Missing SK files** — DFTB+ silently produces wrong results if SK files are incomplete. Verify all element pairs exist.
2. **MaxAngularMomentum mismatch** — must exactly match what the SK file provides (check SK file header)
3. **No SK files for element pair** — DFTB+ cannot treat arbitrary element combinations. Check dftb.org/parameters.
4. **Units** — DFTB+ uses atomic units internally (Bohr, Hartree). GEN files use Angstrom by default.
5. **Dispersion missing** — add `Dispersion = DftD3 {}` for van der Waals systems
6. **Spin polarization** — add `SpinPolarisation = Colinear { ... }` for magnetic systems; not all SK sets support it
