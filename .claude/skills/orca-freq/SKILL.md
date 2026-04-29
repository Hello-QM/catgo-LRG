---
name: orca-freq
description: ORCA frequency calculation. Computes vibrational frequencies, IR intensities, zero-point energy, and thermochemistry at specified temperature/pressure.
---

# ORCA Frequency Calculation Skill

## When to Use

Use this skill when the user wants to:
- Compute vibrational frequencies of a molecule
- Get an IR spectrum
- Calculate zero-point energy (ZPE)
- Obtain thermochemical quantities (enthalpy, entropy, Gibbs free energy)
- Verify a transition state (exactly one imaginary frequency)
- Confirm a minimum (no imaginary frequencies)

## Prerequisites

The input structure MUST be optimized at the same level of theory used for the
frequency calculation. Running frequencies on an unoptimized structure will
produce meaningless imaginary frequencies.

## MCP Tool Examples

### Basic frequency calculation

```json
catgo_workflow_engine(action: "create", params: {
  name: "Water frequencies B3LYP"
})
```

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "freq",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 1
  }
})
```

### Opt + Freq chain (recommended workflow)

Always optimize first, then run frequencies on the result:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "geo_opt",
  task_id: "opt1",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-TZVP",
    orca_extra_keywords: "TightOpt D3BJ",
    charge: 0,
    multiplicity: 1
  }
})
```

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "freq",
  task_id: "freq1",
  depends_on: ["opt1"],
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-TZVP",
    orca_extra_keywords: "D3BJ",
    charge: 0,
    multiplicity: 1
  }
})
```

### Thermochemistry at non-standard conditions

ORCA computes thermochemistry at 298.15 K and 1 atm by default. For other
conditions, the Gibbs energy correction can be computed via the `gibbs_energy`
analysis task:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "gibbs_energy",
  depends_on: ["opt1", "freq1"],
  params: {
    temperature: 373.15,
    phase: "gas"
  }
})
```

### Get frequency results

```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "freq1"
})
```

The result contains:
- `frequencies`: list of vibrational frequencies in cm-1
- `intensities`: IR intensities in km/mol
- `is_imaginary`: boolean flags for each frequency
- `zpe`: zero-point energy in eV
- `thermochemistry`: dict with H, S, G at standard conditions

## Interpreting Results

### Minima verification
- All frequencies should be real (positive)
- Small negative frequencies (<50 cm-1) are numerical noise, usually harmless
- Large imaginary frequencies indicate the structure is NOT a minimum

### Transition state verification
- Exactly ONE imaginary frequency (negative value)
- The imaginary mode should correspond to the expected reaction coordinate
- Use `catgo_view` to visualize the mode

### Thermochemistry output

ORCA prints a thermochemistry block with:

| Quantity | Symbol | Units |
|---|---|---|
| Zero-point energy | ZPE | eV (or kcal/mol) |
| Thermal energy | U | eV |
| Enthalpy | H = U + pV | eV |
| Entropy | S | eV/K |
| Gibbs free energy | G = H - TS | eV |

For catalysis, feed the DFT energy and frequencies into `gibbs_energy`:
- `phase: "adsorbed"` -- harmonic approximation (no translational/rotational)
- `phase: "gas"` -- ideal gas (includes translation, rotation, vibration)

## Frequency Scaling Factors

DFT frequencies are systematically overestimated. Common scaling factors:

| Method | Scaling factor |
|---|---|
| B3LYP/def2-SVP | 0.9813 |
| B3LYP/def2-TZVP | 0.9654 |
| PBE/def2-SVP | 0.9948 |
| HF-3c | 0.86 |

These are applied automatically by the `gibbs_energy` task when available.

## Common Mistakes

- Running freq on unoptimized geometry (will show spurious imaginary modes)
- Using different method/basis for opt and freq (inconsistent PES)
- Ignoring imaginary frequencies and proceeding with thermochemistry
- Not using TightOpt for the preceding optimization (loose opt can leave
  residual forces that appear as small imaginary frequencies)

## ORCA-Specific Notes

- ORCA uses analytical frequencies when available, numerical otherwise
- For large molecules (>100 atoms), frequencies become very expensive
- `orca_extra_keywords: "NumFreq"` forces numerical frequencies (slower but
  sometimes needed for exotic functionals)
- ORCA output lists frequencies as negative values for imaginary modes
  (not "i" notation)
