---
name: nrr-overpotential
description: >
  Use when the user asks about NRR (nitrogen reduction reaction), ammonia
  synthesis, N2 fixation, or the electrochemical reduction of N2 to NH3
  on a catalyst surface.
tags: [analysis, catalysis, NRR, nitrogen, ammonia]
---

# NRR Overpotential Calculation

## Theory: Distal Pathway (6-Electron Transfer)

```
N2 --> *N2H --> *NNH2 --> *N + NH3 --> *NH --> *NH2 --> NH3
```

The first protonation step (N2 --> *N2H) is typically rate-limiting.
The thermodynamic equilibrium potential for N2 + 6H+ + 6e- --> 2NH3
is -0.16 V vs RHE at 298 K.

### Overpotential

```
eta_NRR = max(dG_steps) + U_eq
```

where U_eq = -0.16 V (thermodynamic potential for N2 reduction).

### Atom-Balanced Free Energy Steps (Distal Pathway, CHE Convention)

Using the computational hydrogen electrode: G(H+ + e-) = 0.5 * G(H2) at U=0V.
Each step must balance all atoms (N, H) on both sides:

```
Step 1: * + N2(g) + H+ + e- --> *N2H
  dG1 = G(*N2H) - G(*) - G(N2) - 0.5*G(H2)

Step 2: *N2H + H+ + e- --> *NNH2
  dG2 = G(*NNH2) - G(*N2H) - 0.5*G(H2)

Step 3: *NNH2 + H+ + e- --> *N + NH3(g)
  dG3 = G(*N) + G(NH3) - G(*NNH2) - 0.5*G(H2)

Step 4: *N + H+ + e- --> *NH
  dG4 = G(*NH) - G(*N) - 0.5*G(H2)

Step 5: *NH + H+ + e- --> *NH2
  dG5 = G(*NH2) - G(*NH) - 0.5*G(H2)

Step 6: *NH2 + H+ + e- --> * + NH3(g)
  dG6 = G(*) + G(NH3) - G(*NH2) - 0.5*G(H2)
```

**Important:** All G values must be **Gibbs free energies** (from geo_opt + freq +
gibbs_energy chain), NOT raw DFT electronic energies. Using E_DFT instead of G
omits ZPE and entropy, leading to errors of 0.2-0.5 eV per step.

### pH Correction

At non-zero pH, each proton-transfer step is corrected by:

```
dG_i(pH) = dG_i - 0.059 * pH   (eV, at 298 K)
```

This shifts the free energy of every (H+ + e-) transfer by -0.059 eV per pH unit
(Nernst relation). At pH 0, no correction is needed.

### Simplified Descriptor

The binding energy of the first protonation intermediate (*N2H) is
the primary descriptor for NRR activity. A strong *N2H binding activates
N2 but may trap intermediates; weak binding gives poor N2 activation.

## Discussion Checkpoints

🔴 **Must discuss with user:**
- **Pathway choice** — distal vs alternating vs enzymatic; different pathways have different intermediates and rate-limiting steps; distal is most common on metal surfaces but alternating dominates on some single-atom catalysts
- **Surface choice** — Miller index, composition, and defect sites; Fe(110) and Mo-based catalysts are canonical NRR surfaces
- **Functional** — must be consistent across all 5+ intermediates; SCAN may give different N2 activation barriers than PBE
- **ISPIN** — must be 2 for NRR; N2 activation is spin-dependent, especially on Fe, Mo, and other magnetic substrates; ISPIN=1 gives qualitatively wrong energetics

🟡 **Recommend confirming:**
- Competing HER — always compare dG_N2H with dG_H* on the same surface; a good NRR catalyst must suppress HER (dG_H* > 0)
- N2 reference state — gas-phase N2 is extremely stable (9.79 eV bond); must use consistent G(N2) from freq + gibbs with phase="gas"

🟢 **Safe defaults:**
- 6-electron distal pathway
- U_eq = -0.16 V vs RHE (thermodynamic equilibrium potential)
- CHE reference: G(H+ + e-) = 0.5*G(H2)

## MCP Tool: catgo_catalysis action="nrr"

### Basic NRR Overpotential (Single Descriptor)

Using only the first protonation step energy:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "nrr",
  "params": {
    "dG_N2H": 0.5
  }
}}
```

### Full Pathway Analysis

Provide multiple intermediate energies for a more detailed analysis:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "nrr",
  "params": {
    "dG_N2H": 0.50,
    "dG_NNH2": 0.35,
    "dG_N": -0.20,
    "dG_NH": -0.45,
    "dG_NH2": -0.30,
    "dG_NH3": -0.10,
    "pathway": "distal"
  }
}}
```

### Alternating Pathway

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "nrr",
  "params": {
    "dG_N2H": 0.65,
    "pathway": "alternating"
  }
}}
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| dG_N2H | float | -- | Free energy of first protonation (eV), **required** |
| dG_NNH2 | float | null | Free energy of *NNH2 intermediate (eV) |
| dG_N | float | null | Free energy of *N intermediate (eV) |
| dG_NH | float | null | Free energy of *NH intermediate (eV) |
| dG_NH2 | float | null | Free energy of *NH2 intermediate (eV) |
| dG_NH3 | float | null | Free energy of NH3 desorption step (eV) |
| pathway | string | "distal" | Pathway: `distal`, `alternating`, or `enzymatic` |
| equilibrium_potential | float | -0.16 | Thermodynamic potential (V vs RHE) |

## Return Format

```json
{
  "overpotential": 0.34,
  "limiting_step": 1,
  "step_energies": [0.50],
  "pathway": "distal",
  "dG_N2H": 0.50
}
```

## Complete MCP Workflow: NRR on Fe(110)

### 1. Create workflow

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "create", "name": "NRR on Fe(110)"
}}
```

### 2. Build slab and adsorbate structures

For each intermediate (*N2H, *NNH2, *N, *NH, *NH2):

```json
{"tool": "catgo_structure", "arguments": {
  "action": "slab", "miller_index": [1,1,0],
  "min_slab_size": 12.0, "min_vacuum_size": 15.0
}}
```

### 3. For each intermediate: geo_opt --> freq --> gibbs_energy

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_nrr",
  "node_type": "geo_opt",
  "params": {"software": "vasp", "ENCUT": 520, "ISPIN": 2,
             "system_name": "*N2H"}
}}
```

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_nrr",
  "node_type": "freq", "depends_on": "task_n2h_opt",
  "params": {"software": "vasp", "freeze_mode": "layers",
             "freeze_layers": 4, "system_name": "*N2H"}
}}
```

```json
{"tool": "catgo_workflow", "arguments": {
  "action": "add_node", "workflow_id": "wf_nrr",
  "node_type": "gibbs_energy",
  "params": {"phase": "adsorbed", "system_name": "*N2H"}
}}
```

### 4. Add gas-phase references (N2, H2, NH3)

All gas-phase references need geo_opt --> freq --> gibbs with `phase="gas"`:

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "molecule", "query": "nitrogen"
}}
```

```json
{"tool": "catgo_fetch", "arguments": {
  "action": "molecule", "query": "ammonia"
}}
```

### 5. Compute overpotential

After all Gibbs energies are computed, calculate the free energy steps
and call:

```json
{"tool": "catgo_catalysis", "arguments": {
  "action": "nrr",
  "params": {"dG_N2H": 0.50}
}}
```

## DAG Structure

```
clean_slab --> geo_opt
*N2H  --> geo_opt --> freq --> gibbs
*NNH2 --> geo_opt --> freq --> gibbs
*N    --> geo_opt --> freq --> gibbs
*NH   --> geo_opt --> freq --> gibbs
*NH2  --> geo_opt --> freq --> gibbs
N2(g)  --> geo_opt --> freq --> gibbs (gas)
H2(g)  --> geo_opt --> freq --> gibbs (gas)
NH3(g) --> geo_opt --> freq --> gibbs (gas)
```

Total: ~23 tasks. The 8 branches are independent and run in parallel.

## Common Pitfalls

1. NRR competes with HER (hydrogen evolution). A good NRR catalyst
   must suppress HER, so always compare dG_N2H with dG_H on the same
   surface.
2. The distal pathway (most common on metal surfaces) cleaves the N-N
   bond after partial hydrogenation. The alternating pathway
   hydrogenates both N atoms alternately before cleaving.
3. N2 activation is spin-dependent. Always use ISPIN=2 for NRR
   calculations, especially on Fe, Mo, and other magnetic substrates.
4. The simplified model uses only dG_N2H as the descriptor. For
   accurate screening, compute at least dG_N2H and dG_NH3 (desorption
   step) to check both ends of the pathway.
5. Gas-phase N2 is extremely stable (bond energy 9.79 eV). Use
   consistent reference energies: G(N2) from a gas-phase frequency
   calculation with `phase="gas"`.
