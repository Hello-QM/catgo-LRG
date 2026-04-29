---
name: gaussian
description: >
  Generate and manage Gaussian calculations. Use when the user requests Gaussian,
  G16, GJF files, or needs hybrid functionals (B3LYP), MP2, CCSD(T), or molecular
  quantum chemistry with Gaussian basis sets.
compatibility: >
  Requires a valid Gaussian license and installation on the HPC target.
  Gaussian is commercial software — never distribute binaries or bypass license checks.
---

# Gaussian

## When to Use

- User explicitly requests Gaussian, G16, G09
- User needs molecular quantum chemistry (not periodic solids — use VASP/QE for that)
- User wants hybrid functionals (B3LYP, PBE0, M06-2X) for molecules
- User needs post-HF methods: MP2, CCSD(T), CBS extrapolation
- User wants transition state search with QST2/QST3
- User requests GJF/COM input file generation

## Prerequisites

1. Gaussian (g16/g09) accessible on HPC with valid license
2. Sufficient memory and scratch space (Gaussian is memory-intensive)
3. Structure loaded in viewer — verify with `catgo_view(action="get_state")`

## Workflow Steps

### 1. Verify structure

```
catgo_view(action="get_state")
```

### 2. Create workflow

```
catgo_workflow_engine(action="create", params={"name": "Gaussian B3LYP opt+freq"})
```

### 3. Add Gaussian task via shell

CatGo does not yet have a native Gaussian engine. Use `task_type: "shell"`.

```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "shell",
  "name": "g16_opt",
  "command": "g16 < input.gjf > output.log 2>&1",
  "input_files": {
    "input.gjf": "<GJF content>"
  },
  "system_name": "caffeine_opt"
})
```

When a `@register_engine("gaussian")` is added, use `task_type: "geo_opt"` with `software: "gaussian"`.

## Input File Template — Optimization + Frequencies

```
%nproc=16
%mem=32GB
%chk=checkpoint.chk
# opt freq b3lyp/6-311+g(d,p) empiricaldispersion=gd3bj
  scf=tight int=ultrafine

Title: Geometry optimization with frequency analysis

0 1
C    0.000000    0.000000    0.000000
H    0.000000    0.000000    1.089000
H    1.026719    0.000000   -0.363000
H   -0.513360   -0.889165   -0.363000
H   -0.513360    0.889165   -0.363000

```

**Important:** The blank line after coordinates is mandatory. A second blank line terminates the input.

## Input File Structure

```
%nproc=<cores>                    # Link 0 commands (resources)
%mem=<memory>
%chk=<checkpoint_file>
# <method>/<basis> <keywords>     # Route section

<title>                           # Title (free text)

<charge> <multiplicity>           # Charge and spin
<element> <x> <y> <z>            # Cartesian coordinates
                                  # Blank line = end of molecule
```

## Parameter Guidance

| Parameter | Typical value | Notes |
|---|---|---|
| Method | B3LYP, PBE0, M06-2X, wB97XD | Hybrid DFT for molecules |
| Basis | 6-31G(d), 6-311+G(d,p), def2-TZVP | Pople or Karlsruhe basis sets |
| %mem | 4-64 GB | Gaussian stores integrals in memory |
| %nproc | 8-32 | Shared-memory parallel |
| Dispersion | EmpiricalDispersion=GD3BJ | Add for non-covalent interactions |
| int | UltraFine | Integration grid; always use for DFT |
| scf | Tight | SCF convergence; XTight for frequencies |

## Common Calculation Types

| Keyword | Purpose |
|---|---|
| `opt` | Geometry optimization |
| `freq` | Vibrational frequencies (must be at a stationary point) |
| `opt freq` | Optimize then frequencies in one job |
| `opt=(ts,calcfc,noeigen)` | Transition state search |
| `opt=(qst2)` | TS search from reactant+product geometries |
| `irc=(calcfc,maxpoints=50)` | Intrinsic reaction coordinate |
| `td=(nstates=10)` | TD-DFT excited states |
| `nmr` | NMR chemical shifts |
| `pop=nbo` | Natural bond orbital analysis |

## Solvent Effects

Add implicit solvation:
```
# opt freq b3lyp/6-311+g(d,p) scrf=(smd,solvent=water)
```

## Common Pitfalls

1. **Missing blank lines** — Gaussian input requires blank lines between sections and after coordinates. Missing them causes cryptic errors.
2. **Wrong multiplicity** — open-shell systems need correct spin (2S+1). Doublet radicals: multiplicity=2.
3. **%mem too low** — Gaussian crashes with "galloc: could not allocate memory". Set %mem to ~80% of available RAM.
4. **Basis set not available** — not all basis sets cover all elements. Heavy elements need ECP (e.g., LANL2DZ).
5. **Frequencies at non-stationary point** — `freq` requires a fully optimized geometry. Run `opt freq` together.
6. **License restrictions** — never share Gaussian binaries. Ensure the HPC has a valid site license.
7. **Checkpoint file not saved** — always use `%chk` for restart capability and property extraction
8. **Forgetting dispersion** — B3LYP without GD3/GD3BJ underestimates non-covalent interactions
