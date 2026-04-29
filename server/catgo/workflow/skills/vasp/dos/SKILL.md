---
name: vasp-dos
description: Density of states (DOS) workflow in VASP. Three-step process for accurate total and projected DOS, d-band center analysis.
---

# VASP Density of States (DOS) Calculation

Compute total and projected density of states. Requires a three-step workflow: geometry optimization, self-consistent single point, and DOS analysis.

## Why Three Steps?

1. **geo_opt** — relax the structure to equilibrium
2. **single_point** — SCF with ISMEAR=-5 (tetrahedron method) and high NEDOS for accurate DOS
3. **dos_analysis** — extract d-band center, orbital projections, and plot data

The tetrahedron method (ISMEAR=-5) gives the most accurate DOS but is incompatible with geometry optimization (forces are not well-defined). That is why a separate single point is needed.

## Full DOS Workflow

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, single_point, dos_analysis

wf = Workflow("RuO2 DOS")
struct = wf.add_task("structure_input", structure=structure_json)

# Step 1: Optimize geometry
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2, system_name="relax")

# Step 2: Single point with DOS settings
sp = wf.add_task(single_point, structure=opt.output.structure,
                 ISMEAR=-5,       # Tetrahedron method with Blochl corrections
                 NEDOS=3001,      # Dense energy grid (default is 301)
                 LORBIT=11,       # Projected DOS per atom and orbital
                 LCHARG=True,     # Write charge density
                 EDIFF=1e-6,      # Tight convergence
                 system_name="DOS")

# Step 3: Analyze DOS
dos = wf.add_task(dos_analysis, data=sp.output.energy,
                  d_band=True, system_name="DOS_analysis")

wf.submit()
```

## MCP Workflow

```
# Create workflow
catgo_workflow_engine(action="create", params={"name": "DOS calculation"})

# Step 1: Input structure
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<json>"
})

# Step 2: Geometry optimization
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "geo_opt",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "system_name": "relax"
})

# Step 3: Single point for DOS
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "single_point",
  "software": "vasp",
  "structure": "{{t_002.output.structure}}",
  "ISMEAR": -5,
  "NEDOS": 3001,
  "LORBIT": 11,
  "LCHARG": true,
  "EDIFF": 1e-6,
  "system_name": "DOS"
})

# Step 4: DOS analysis
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "dos_analysis",
  "data": "{{t_003.output.energy}}",
  "d_band": true,
  "system_name": "DOS_analysis"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Key DOS Parameters

| Parameter | Value | Purpose |
|---|---|---|
| ISMEAR | -5 | Tetrahedron method — accurate DOS integration |
| NEDOS | 3001 | Energy grid points (more = smoother DOS) |
| LORBIT | 11 | Write atom-projected and orbital-projected DOS |
| EMIN/EMAX | auto | Energy range (auto-detected from eigenvalues) |
| LCHARG | True | Write CHGCAR for post-processing |

## ISMEAR=-5 Requirements

- Requires at least 3 k-points in each periodic direction
- Do NOT use for Gamma-only calculations (use ISMEAR=0 instead)
- Do NOT use during geometry optimization (forces are inaccurate)
- For metals with few k-points, use ISMEAR=1, SIGMA=0.2 and accept slightly noisier DOS

## d-Band Center Analysis

The dos_analysis task computes the d-band center for transition metals:

```
d_band_center = integral(rho_d(E) * E dE) / integral(rho_d(E) dE)
```

This is valuable for catalysis studies (Norskov d-band model). The analysis automatically identifies transition metal atoms and extracts their d-orbital projected DOS.

## Spin-Polarized DOS

For magnetic systems, set ISPIN=2 to get spin-up and spin-down DOS separately:

```python
sp = wf.add_task(single_point, structure=opt.output.structure,
                 ISMEAR=-5, NEDOS=3001, LORBIT=11,
                 ISPIN=2,
                 MAGMOM="4*5.0 8*0.6",  # Initial moments
                 system_name="DOS_spin")
```

## Partial DOS (PDOS) for Specific Atoms

LORBIT=11 writes per-atom projections. The dos_analysis task can extract DOS for specific atoms or orbitals. Common use cases:

- **Surface vs bulk atoms**: compare DOS of surface layer vs interior
- **Adsorbate bonding**: compare adsorbate p-states with metal d-states
- **Alloying effects**: compare d-band of alloy components

## Skip Optimization (Pre-Optimized Structure)

If the structure is already optimized, skip step 1:

```python
wf = Workflow("DOS only")
struct = wf.add_task("structure_input", structure=optimized_json)
sp = wf.add_task(single_point, structure=struct.output.structure,
                 ISMEAR=-5, NEDOS=3001, LORBIT=11,
                 system_name="DOS")
wf.submit()
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Noisy/spiky DOS | Increase NEDOS (try 5001), use ISMEAR=-5 |
| ISMEAR=-5 error | Need >= 3 k-points per direction. Increase k-mesh |
| No d-band center | dos_analysis only computes d-band for transition metals |
| DOS looks wrong | Check that SCF is converged (EDIFF=1e-6), check ISPIN for magnetic systems |
| Fermi level misplaced | VASP sets E_F automatically; verify with band structure |

## Output

The single_point task produces raw DOSCAR data. The dos_analysis task produces:
- `output.dos_data` — total and projected DOS as plottable arrays
- d-band center, d-band width, and band gap (if applicable)
