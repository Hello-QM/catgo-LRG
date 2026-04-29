---
name: vasp-router
description: Route VASP calculation requests to the correct task type. Enforces VASP-specific policies for POTCAR, ENCUT, k-points, and slab handling.
---

# VASP Router

Route VASP requests to the appropriate sub-skill based on the calculation type.

## Routing Table

| User intent | Route to |
|---|---|
| Geometry optimization, relaxation, structural optimization | `relax/SKILL.md` |
| Single point energy, SCF calculation | `static/SKILL.md` |
| Density of states (DOS, PDOS, d-band center) | `dos/SKILL.md` |
| Band structure, electronic bands | `band/SKILL.md` |
| Vibrational frequencies, ZPE, thermodynamics | `freq/SKILL.md` |
| Ab initio molecular dynamics (AIMD) | `md/SKILL.md` |

## VASP-Specific Policies — ALWAYS enforce these

### 1. POTCAR selection

POTCAR is handled automatically by the HPC engine based on the structure's elements. You do NOT need to specify POTCAR files. The engine uses the recommended POTCARs (e.g., `Ti_pv`, `O`, `Ru_pv`).

If the user requests specific POTCARs (e.g., `_sv` variants), pass them via:
```python
wf.add_task(geo_opt, structure=s, POTCAR_MAP={"Ti": "Ti_sv", "O": "O"})
```

### 2. ENCUT selection

Default: **520 eV** (suitable for most oxide catalysts).

Guidelines:
- Bulk metals: 400-520 eV usually sufficient
- Oxides and surfaces: 520 eV recommended
- Convergence tests: test 400, 450, 500, 550, 600 eV
- If user specifies ENCUT, respect it without question

### 3. K-points

K-points are auto-generated from the structure's cell dimensions. Override with:
```python
wf.add_task(geo_opt, structure=s, KPOINTS=[4, 4, 1])  # Gamma-centered
```

Slab guideline: use [N, N, 1] where N gives ~0.03 A^-1 spacing in-plane.

### 4. ISPIN for magnetic systems

Default: ISPIN=1 (non-spin-polarized).

Set ISPIN=2 for:
- Transition metals: Fe, Co, Ni, Mn, Cr
- Their oxides: Fe2O3, CoO, NiO, MnO2
- Any system where user mentions magnetism or spin

```python
wf.add_task(geo_opt, structure=s, ISPIN=2, MAGMOM="5*4.0 10*0.6")
```

### 5. Slab calculations — frozen layers

For surface slabs, ALWAYS freeze bottom layers:

```python
# Typical 4-layer slab: freeze bottom 2 layers
wf.add_task(geo_opt, structure=slab,
            ISIF=2,           # Fix cell shape (mandatory for slabs)
            selective_dynamics=True,
            freeze_layers=2)  # Freeze bottom 2 layers
```

Rules:
- ISIF must be 2 for slabs (never 3 — that allows cell shape change)
- Freeze at least the bottom half of slab layers
- Adsorbate atoms are always free to move

### 6. Dispersion corrections

For adsorption studies, consider DFT-D3:
```python
wf.add_task(geo_opt, structure=s, IVDW=11, LDAU=False)
```

Only add if user requests it or the system involves weak interactions (physisorption, vdW heterostructures).

## Config Defaults (from ~/.catgo/config.yaml)

These are the system defaults. Only specify parameters that differ:

```yaml
defaults.vasp:
  ENCUT: 520
  EDIFF: 1e-5
  PREC: Accurate
  ALGO: Fast
  ISMEAR: 0
  SIGMA: 0.05
  LREAL: Auto
  NELM: 200
  ISPIN: 1
  LORBIT: 11
  LWAVE: False
  LCHARG: False
  NCORE: 4
```

## Quick Examples

### Bulk relaxation
```python
wf.add_task(geo_opt, structure=bulk_json, ISIF=3, system_name="bulk_TiO2")
```

### Slab relaxation with frozen layers
```python
wf.add_task(geo_opt, structure=slab_json, ISIF=2,
            freeze_layers=2, system_name="TiO2_110_slab")
```

### Single point after relaxation
```python
opt = wf.add_task(geo_opt, structure=s, system_name="opt")
sp = wf.add_task("single_point", structure=opt.output.structure, system_name="SP")
```

### Full OER chain (per adsorbate)
```python
opt = wf.add_task(geo_opt, structure=s, ISIF=2, freeze_layers=2, system_name="*OH")
frq = wf.add_task(freq, structure=opt.output.structure,
                  freeze_mode="layers", freeze_layers=4, system_name="*OH")
gib = wf.add_task(gibbs_energy, energy=opt.output.energy,
                  frequencies=frq.output.frequencies, system_name="*OH")
```

## MCP Workflow Creation

```
catgo_workflow_engine(action="create", params={"name": "VASP relaxation"})
# → {"workflow_id": "wf_xxx"}

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "geo_opt",
  "software": "vasp",
  "structure": "<json>",
  "ISIF": 2,
  "system_name": "slab_relax"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Common Mistakes to Avoid

1. Using ISIF=3 for slabs (allows cell to change shape — unphysical for surfaces)
2. Forgetting to freeze bottom slab layers (all atoms relax toward vacuum)
3. Using ISMEAR=0 for metals (should use ISMEAR=1, SIGMA=0.2 for metals)
4. Setting LREAL=.FALSE. for large cells >200 atoms (use LREAL=Auto)
5. Not setting ISPIN=2 for magnetic systems (wrong energetics)
