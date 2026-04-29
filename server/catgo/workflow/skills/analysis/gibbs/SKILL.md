---
name: gibbs-free-energy
description: >
  Use when the user asks for Gibbs free energy, zero-point energy (ZPE),
  thermal corrections, or thermodynamic properties from DFT + frequency data.
---

# Gibbs Free Energy Calculation

## Theory

```
G = E_DFT + ZPE - TS
```

Where:
- `E_DFT` = electronic energy from geometry optimization (eV)
- `ZPE` = zero-point energy = (1/2) * sum(h * nu_i) for all real frequencies
- `TS` = entropic contribution at temperature T

### Phase Modes

| Phase | Treatment | When to Use |
|-------|-----------|-------------|
| `adsorbed` | Harmonic approximation: all 3N modes treated as vibrations. No translational/rotational entropy. | Adsorbate on surface slab |
| `gas` | Ideal gas: translational + rotational + vibrational partition functions (Shomate/statistical mechanics). | Free molecule in gas phase (H2, H2O, O2, etc.) |

### Frequency Cutoff

Low-frequency modes (< 50 cm-1) in adsorbed species are often numerical noise
from frustrated translations/rotations. These are replaced with `freq_cutoff`
(default 50 cm-1) to avoid divergent entropy contributions.

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Phase (adsorbed vs gas)** — wrong phase gives wrong entropy; adsorbed species use harmonic approximation (no translational/rotational entropy), gas-phase species use ideal gas partition function; the difference is 0.3-0.6 eV for molecules like H2O

🟡 **Recommend confirming:**
- Temperature (default: 298.15 K) — change for high-temperature catalysis (e.g., 600 K for thermal CO2 reduction, 373 K for steam reforming)
- Frequency cutoff (default: 50 cm-1) — replaces frustrated translations/rotations below this threshold for adsorbed species; increase to 100 cm-1 if anomalous entropy values appear

🟢 **Safe defaults:**
- Harmonic approximation for adsorbed species
- Ideal gas partition function for gas-phase molecules
- Pressure = 101325 Pa (1 atm)
- freq_cutoff = 50 cm-1

## MCP Workflow

### Step 1: Create workflow and add structure

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "create", "name": "Gibbs energy - OH on Pt(111)"
}}
```

### Step 2: Add geo_opt task

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task",
  "workflow_id": "wf_abc123",
  "task_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "EDIFFG": -0.02}
}}
```

### Step 3: Add frequency task

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task",
  "workflow_id": "wf_abc123",
  "task_type": "freq",
  "depends_on": "task_opt",
  "params": {
    "software": "vasp",
    "freeze_mode": "layers",
    "freeze_layers": 4
  }
}}
```

### Step 4: Add gibbs_energy task

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "add_task",
  "workflow_id": "wf_abc123",
  "task_type": "gibbs_energy",
  "depends_on": ["task_opt", "task_freq"],
  "params": {
    "phase": "adsorbed",
    "temperature": 298.15,
    "freq_cutoff": 50
  }
}}
```

### Step 5: Submit

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "submit", "workflow_id": "wf_abc123"
}}
```

## Python API

```python
from catgo.workflow import Workflow

wf = Workflow("Gibbs energy - OH on Pt(111)")

inp = wf.add_task("structure_input", structure=slab_oh_json)

opt = wf.add_task("geo_opt",
    structure=inp.output.structure,
    software="vasp", ENCUT=520, EDIFFG=-0.02)

frq = wf.add_task("freq",
    structure=opt.output.structure,
    software="vasp",
    freeze_mode="layers", freeze_layers=4)

gib = wf.add_task("gibbs_energy",
    energy=opt.output.energy,
    frequencies=frq.output.frequencies,
    phase="adsorbed",
    temperature=298.15,
    freq_cutoff=50)

wf.submit()
```

## Output References

```python
gib.output.gibbs        # G in eV
gib.output.zpe          # ZPE in eV
gib.output.entropy      # TS in eV
gib.output.enthalpy     # H in eV
```

## Checking Results

```json
{"tool": "catgo_workflow_engine", "arguments": {
  "action": "get_result", "workflow_id": "wf_abc123", "task_id": "task_gibbs"
}}
```

## Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `phase` | `"adsorbed"` | `"adsorbed"` (harmonic) or `"gas"` (ideal gas) |
| `temperature` | `298.15` | Temperature in Kelvin |
| `freq_cutoff` | `50` | Replace frequencies below this (cm-1) with this value. Adsorbed phase only. |
| `pressure` | `101325` | Pressure in Pa. Gas phase only. |

## Why Gibbs Free Energy Matters

For reaction energy diagrams (OER, HER, CO2RR, NRR), you **must** use Gibbs
free energies, not raw DFT electronic energies. The difference matters:

| Contribution | Typical magnitude |
|-------------|------------------|
| ZPE (zero-point energy) | +0.05 to +0.5 eV |
| -TS (entropic correction) | -0.1 to -0.6 eV |
| Total correction (G - E_DFT) | -0.1 to +0.3 eV |

Gas-phase molecules (H2, H2O, CO2, N2) have large translational and rotational
entropy contributions. Adsorbed species lose these degrees of freedom, so the
correction differs significantly between gas and adsorbed phases. Omitting the
gibbs_energy step introduces systematic errors of 0.2-0.5 eV per reaction step.

Every species in a reaction (intermediates AND gas-phase references) must go
through: **geo_opt --> freq --> gibbs_energy**.

## Common Pitfalls

1. Never skip the freq task -- ZPE and TS require vibrational frequencies.
2. For adsorbed species, always freeze slab bottom layers in freq calculation.
3. Gas-phase references (H2, H2O, CO2, N2, NH3) must use `phase="gas"` to
   include translational and rotational entropy.
4. The `energy` input must come from geo_opt (relaxed), not single_point.
5. If you get anomalously large entropy, check for near-zero frequencies --
   increase `freq_cutoff` or verify the structure is properly relaxed.
6. Never use raw DFT energies (E_DFT) in reaction energy diagrams. Always
   complete the full chain: geo_opt --> freq --> gibbs_energy.
