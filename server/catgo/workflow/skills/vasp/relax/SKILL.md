---
name: vasp-relax
description: VASP geometry optimization (relaxation). Handles bulk, slab, and adsorbate-on-slab scenarios with correct ISIF, frozen layers, and convergence settings.
---

# VASP Geometry Optimization

Set up and submit VASP geometry optimizations. Three main scenarios with different parameter requirements.

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Functional (METAGGA/GGA/+U)** — PBE vs SCAN vs PBE+U fundamentally changes energetics; wrong functional invalidates the entire study
- **ISPIN** — must be 2 for magnetic systems (Fe, Co, Ni, Mn oxides, NRR substrates); default ISPIN=1 gives wrong energies for magnetic materials
- **Structure source** — bulk from Materials Project vs user-uploaded CIF vs previous optimization; wrong starting structure wastes all compute

🟡 **Recommend confirming:**
- ENCUT (default: 520) — increase to 600+ for accurate equation of state or when comparing across different compositions
- EDIFFG (default: -0.02 eV/A) — tighten to -0.01 for frequency calculations downstream; loosen to -0.05 for quick screening
- k-points — must be converged for the system; small unit cells need denser meshes
- Selective dynamics / frozen layers (default: freeze_layers=2 for slabs) — adjust based on slab thickness and whether subsurface relaxation matters
- ISIF (default: 2) — must be 3 for bulk relaxation, 2 for slabs; wrong ISIF is a common mistake

🟢 **Safe defaults:**
- EDIFF = 1E-5
- ISMEAR = 0, SIGMA = 0.05
- NSW = 200
- IBRION = 2 (conjugate gradient)
- PREC = Accurate
- NCORE = 4

## Scenario 1: Bulk Relaxation

Full cell + ionic relaxation. Use ISIF=3 to allow cell shape and volume to change.

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt

wf = Workflow("Bulk TiO2 relaxation")
struct = wf.add_task("structure_input", structure=bulk_json)
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=3,        # Relax cell shape + volume + ions
                  EDIFFG=-0.02,  # Force convergence (eV/A)
                  system_name="bulk_TiO2")
wf.submit()
```

**Key parameters:**
- `ISIF=3` — relax ions + cell shape + cell volume
- `EDIFFG=-0.02` — converge when max force < 0.02 eV/A (negative = force criterion)
- `NSW=200` — max ionic steps (default, usually converges in 50-100)

**MCP equivalent:**
```
catgo_workflow_engine(action="create", params={"name": "Bulk TiO2"})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "name": "input",
  "structure": "<bulk_json>"
})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "geo_opt",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "ISIF": 3,
  "system_name": "bulk_TiO2"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Scenario 2: Slab Relaxation (Clean Surface)

Fixed cell, relax only ions. Bottom layers frozen to mimic bulk.

```python
wf = Workflow("RuO2(110) slab")
struct = wf.add_task("structure_input", structure=slab_json)
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2,              # Fix cell, relax ions only
                  selective_dynamics=True,
                  freeze_layers=2,     # Freeze bottom 2 layers
                  system_name="clean_slab")
wf.submit()
```

**Key parameters:**
- `ISIF=2` — MANDATORY for slabs. Fixes cell shape and volume
- `freeze_layers=2` — freeze bottom N layers (sorted by z-coordinate)
- `selective_dynamics=True` — enable per-atom freeze in POSCAR
- Vacuum: ensure >= 15 A in z-direction to avoid periodic image interaction

**ISIF reference:**
| ISIF | Ions | Cell shape | Cell volume | Use case |
|------|------|-----------|-------------|----------|
| 2 | Yes | No | No | Slabs, adsorbates |
| 3 | Yes | Yes | Yes | Bulk relaxation |
| 4 | Yes | Yes | No | Bulk at fixed volume |

## Scenario 3: Adsorbate on Slab

Same as slab relaxation, but the structure has an adsorbate. Adsorbate atoms are always free.

```python
wf = Workflow("OH on RuO2(110)")
struct = wf.add_task("structure_input", structure=adsorbate_slab_json)
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2,
                  selective_dynamics=True,
                  freeze_layers=2,
                  EDIFFG=-0.02,
                  system_name="*OH")
wf.submit()
```

**Guidelines for adsorbates:**
- freeze_layers only affects the slab — adsorbate atoms above the surface are always relaxed
- Use `system_name="*OH"` convention (asterisk = adsorbed species)
- For weak adsorbates (CO2, H2O physisorption), add `IVDW=11` for DFT-D3

## Confirmation Gate

By default, HPC tasks (including VASP relaxation) pause at **PENDING_REVIEW** after local preprocessing completes. This lets users verify the structure, frozen layers, and VASP parameters in the task detail panel before committing HPC resources. Click "Confirm & Submit" in the UI, or use `wf.submit(auto_submit=True)` to bypass the gate.

## Visual Verification Steps

Before submitting, verify the structure in the viewer:

```
# Step 1: Check current structure in viewer
catgo_view(action="get_state")
# Verify: correct composition, reasonable cell parameters, vacuum > 15 A for slabs

# Step 2: For slabs, verify frozen atoms
catgo_view(action="get_state")
# Check that bottom-layer atoms will be frozen

# Step 3: After optimization completes, push result to viewer
catgo_workflow_engine(action="get_result", params={"task_id": "t_opt"})
catgo_view(action="push", params={"structure": "<optimized_structure_json>"})
```

## Convergence Monitoring

```
# Check if optimization is converged
catgo_analyze(action="convergence", params={"task_id": "t_opt"})
# Returns: energy vs step, max force vs step, whether converged

# Check remaining forces
catgo_analyze(action="forces", params={"task_id": "t_opt"})
# Returns: per-atom forces, max force, force on each species
```

## Common Chain: Relaxation then Frequency

For thermodynamic properties (Gibbs energy, ZPE), chain relaxation with frequency:

```python
from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

wf = Workflow("OH adsorption thermodynamics")
struct = wf.add_task("structure_input", structure=slab_oh_json)

opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2, freeze_layers=2, system_name="*OH")

frq = wf.add_task(freq, structure=opt.output.structure,
                  freeze_mode="layers", freeze_layers=4,
                  system_name="*OH")

gib = wf.add_task(gibbs_energy,
                  energy=opt.output.energy,
                  frequencies=frq.output.frequencies,
                  phase="adsorbed", system_name="*OH")

wf.submit()
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Forces not converging | Increase NSW (e.g., 400), or loosen EDIFFG to -0.03 |
| Atoms escaping into vacuum | Check initial adsorbate placement, reduce POTIM to 0.3 |
| SCF not converging | Switch ALGO=All, increase NELM=400, try AMIX=0.1 |
| Cell shape changing for slab | Ensure ISIF=2, not ISIF=3 |
| Wrong energy (magnetic system) | Set ISPIN=2, provide MAGMOM |

## Parameter Defaults (inherited from config)

These are applied automatically unless overridden:
- ENCUT=520, EDIFF=1e-5, PREC=Accurate
- IBRION=2 (conjugate gradient), NSW=200
- EDIFFG=-0.02, ISIF=2
- ISMEAR=0, SIGMA=0.05 (Gaussian smearing)
- NCORE=4, LREAL=Auto
