---
name: vasp-freq
description: VASP vibrational frequency calculation. Compute ZPE and thermodynamic corrections. Handles frozen atoms for slab systems with multiple freeze modes.
---

# VASP Frequency Calculation

Compute vibrational frequencies using finite differences. Used for zero-point energy (ZPE), thermodynamic corrections, and checking transition states.

## When to Use

1. **After geometry optimization** — compute ZPE and Gibbs energy corrections
2. **Transition state verification** — confirm exactly one imaginary frequency
3. **IR/Raman spectra** — predict vibrational spectra
4. **Thermodynamic properties** — feed into gibbs_energy task

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **freeze_mode** — which atoms vibrate determines the thermodynamic corrections; freezing too few atoms wastes compute, freezing the adsorbate itself gives wrong ZPE
- **LREAL=.FALSE.** — mandatory for frequency calculations; real-space projection introduces noise that corrupts finite-difference frequencies; this is non-negotiable

🟡 **Recommend confirming:**
- POTIM (default: 0.015) — displacement step size; reduce to 0.01 if numerical noise appears, increase to 0.02 for heavier atoms
- NFREE (default: 2) — central differences; increase to 4 for higher accuracy at 2x cost
- ENCUT — must match the preceding geo_opt to ensure consistent forces; mismatched ENCUT invalidates the frequency data

🟢 **Safe defaults:**
- IBRION = 5 (finite differences)
- NSW = 1
- EDIFF = 1E-6 (tighter than geo_opt for clean forces)

## Basic Frequency Calculation

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

wf = Workflow("Frequency calculation")
struct = wf.add_task("structure_input", structure=optimized_json)
frq = wf.add_task(freq, structure=struct.output.structure,
                  system_name="CO_gas")
wf.submit()
```

**MCP equivalent:**
```
catgo_workflow_engine(action="create", params={"name": "Frequency calc"})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "structure_input",
  "structure": "<optimized_json>"
})

catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_xxx",
  "task_type": "freq",
  "software": "vasp",
  "structure": "{{t_001.output.structure}}",
  "system_name": "CO_gas"
})

catgo_workflow_engine(action="submit", params={"workflow_id": "wf_xxx"})
```

## Frozen Atoms for Slab Systems

For adsorbates on surfaces, freeze the slab atoms and only compute frequencies for the adsorbate (and optionally top surface layer). This dramatically reduces cost.

### freeze_mode Options

| Mode | Description | Example |
|---|---|---|
| `"none"` | All atoms vibrate (gas-phase molecules) | Small molecules |
| `"layers"` | Freeze bottom N layers by z-coordinate | `freeze_mode="layers", freeze_layers=4` |
| `"z_range"` | Freeze atoms below a z threshold | `freeze_mode="z_range", freeze_z_below=8.0` |
| `"element"` | Freeze specific elements | `freeze_mode="element", freeze_elements=["Ru", "O"]` |
| `"indices"` | Freeze specific atom indices | `freeze_mode="indices", freeze_indices=[0,1,2,3]` |
| `"manual"` | Use selective_dynamics from structure | Pre-set in POSCAR |

### Recommended: Freeze by Layers

For a typical slab with adsorbate:

```python
opt = wf.add_task(geo_opt, structure=slab_oh_json,
                  ISIF=2, freeze_layers=2, system_name="*OH")

frq = wf.add_task(freq, structure=opt.output.structure,
                  freeze_mode="layers",
                  freeze_layers=4,    # Freeze bottom 4 layers (all slab atoms)
                  system_name="*OH")
```

**Why freeze_layers=4 for freq but freeze_layers=2 for geo_opt?**
- geo_opt: freeze bottom half, let top surface layers relax with adsorbate
- freq: freeze ALL slab atoms, only vibrate the adsorbate + binding site atoms
- This is physically correct: slab phonons are not relevant for adsorption thermodynamics

### Freeze by Z-range

Useful when layer detection is ambiguous:

```python
frq = wf.add_task(freq, structure=opt.output.structure,
                  freeze_mode="z_range",
                  freeze_z_below=12.5,   # Angstrom
                  system_name="*OH")
```

## Chain: Optimization then Frequency then Gibbs Energy

The standard thermodynamics workflow:

```python
wf = Workflow("OH adsorption Gibbs energy")
struct = wf.add_task("structure_input", structure=slab_oh_json)

# Step 1: Optimize geometry
opt = wf.add_task(geo_opt, structure=struct.output.structure,
                  ISIF=2, freeze_layers=2, system_name="*OH")

# Step 2: Frequency on optimized structure
frq = wf.add_task(freq, structure=opt.output.structure,
                  freeze_mode="layers", freeze_layers=4,
                  system_name="*OH")

# Step 3: Gibbs energy from DFT energy + frequencies
gib = wf.add_task(gibbs_energy,
                  energy=opt.output.energy,
                  frequencies=frq.output.frequencies,
                  phase="adsorbed",       # Harmonic approximation for adsorbates
                  temperature=298.15,     # K
                  freq_cutoff=50,         # cm-1, replace low freqs with this value
                  system_name="*OH")

wf.submit()
```

## Gas-Phase Molecule Frequencies

For free molecules (H2, H2O, CO, etc.), do NOT freeze any atoms:

```python
frq = wf.add_task(freq, structure=molecule_json,
                  freeze_mode="none",    # All atoms vibrate
                  system_name="H2O_gas")

gib = wf.add_task(gibbs_energy,
                  energy=opt.output.energy,
                  frequencies=frq.output.frequencies,
                  phase="gas",           # Ideal gas partition function
                  system_name="H2O_gas")
```

**Gas vs adsorbed phase:**
- `phase="adsorbed"`: harmonic approximation, frustrated translations/rotations replaced by freq_cutoff
- `phase="gas"`: ideal gas approximation with translational + rotational contributions

## Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| IBRION | 5 | Finite differences |
| NFREE | 2 | Central differences (2-point) |
| POTIM | 0.015 | Displacement step size (Angstrom) |
| EDIFF | 1e-6 | Tight SCF convergence (tighter than geo_opt) |
| LREAL | .FALSE. | Must be exact for frequencies |

**LREAL=.FALSE. is mandatory.** Real-space projection introduces noise in forces that corrupts finite-difference frequencies. The config default overrides LREAL=Auto for freq tasks.

## Analyzing Results

```
# Check frequencies after completion
catgo_analyze(action="frequencies", params={"task_id": "t_freq"})
# Returns: list of frequencies (cm-1), ZPE, imaginary modes

# Get raw result
catgo_workflow_engine(action="get_result", params={"task_id": "t_freq"})
# Returns: {"frequencies": [...], "zpe": 0.543}
```

## Output

The freq task produces:
- `output.frequencies` — list of vibrational frequencies in cm-1 (negative = imaginary)
- `output.zpe` — zero-point energy in eV

## Troubleshooting

| Problem | Fix |
|---|---|
| Many imaginary frequencies | Structure not converged — re-optimize with tighter EDIFFG=-0.01 |
| One imaginary frequency | Could be a transition state (expected) or shallow minimum — check mode |
| Frequencies seem wrong | Ensure LREAL=.FALSE. and EDIFF=1e-6 |
| Calculation too expensive | Freeze more atoms (increase freeze_layers) |
| Numeric noise in frequencies | Reduce POTIM to 0.01 or increase NFREE to 4 |

## Cost Estimate

Frequency calculations require 6N single-point calculations where N is the number of free atoms (with NFREE=2). For a 5-atom adsorbate on a frozen slab, that is 30 SCF calculations — roughly 30x the cost of a single point.
