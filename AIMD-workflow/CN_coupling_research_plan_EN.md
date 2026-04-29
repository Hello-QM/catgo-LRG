# Theoretical Study of Cation Effects on C-N Coupling Reactions at Cu Surfaces

## 1. Background and Scientific Questions

Electrocatalytic CO₂ reduction (CO₂RR) and NO₃⁻ reduction (NO₃RR) offer a promising route for converting greenhouse gases and aqueous pollutants into value-added nitrogen-containing organic products such as urea, formamide, and amino acid precursors. On Cu-based catalysts, C intermediates from CO₂RR (CO, CHO, CH₂O, etc.) and N intermediates from NO₃RR (NO, NH₂, etc.) can undergo **C-N coupling** at the surface to directly form C-N bonded products.

However, C-N coupling faces several key challenges:
- **Combinatorial complexity**: 5 C-species × 8 N-species = 40 possible coupling pairs. Which pathways are thermodynamically and kinetically feasible?
- **High activation barriers**: C-N bond formation requires overcoming significant free energy barriers. How can these be lowered?
- **Unclear cation effects**: How do alkali metal cations (Li⁺, K⁺) in the electrolyte influence C-N coupling barriers? Do they stabilize the transition state electrostatically, or modify the solvation structure?

This study aims to systematically address these questions.

## 2. System Description

### 2.1 Catalyst Surface

- **Cu(100)**: 4×4 supercell, 3 Cu layers (48 Cu atoms), bottom layer fixed
- Cell dimensions: 10.224 × 10.224 × 37.611 Å
- Rationale: Cu(100) exhibits high selectivity toward C₂ products and nitrogen-containing products in experiments

### 2.2 Electrochemical Interface Model

- **Explicit water layer**: 49 water molecules (~3-4 water layers), providing a realistic solvation environment
- **Cation**: Li⁺ or K⁺ (1 per cell), modeling electrolyte cation effects
- **Total atoms**: ~200 per system

### 2.3 Reaction Intermediates

**C-species** (from CO₂RR):

| Intermediate | Formula | C Oxidation State | Character |
|-------------|---------|-------------------|-----------|
| CO₂ | CO₂ | +4 | Linear, weakly activated |
| *COOH | COOH | +3 | Carboxyl radical |
| *CO | CO | +2 | Surface-bound CO, most reactive C-species |
| *CHO | CHO | +2 | Formyl |
| *CH₂O | CH₂O | 0 | Formaldehyde, C approaching saturation |

**N-species** (from NO₃RR, calculations starting from NO₂):

| Intermediate | Formula | N Oxidation State | Character |
|-------------|---------|-------------------|-----------|
| *NO₂ | NO₂ | +4 | N shielded by O, limited coupling |
| *NO | NO | +2 | Surface-bound NO, N exposed |
| *NOH | NOH | +1 | N-hydroxide |
| *NHOH | NHOH | -1 | Hydroxylamine, nucleophilic N |
| *HNO | HNO | +1 | Nitroxyl |
| *N | N | -3 | Adsorbed N atom, highly reactive |
| *NH | NH | -3 | Imide, strong nucleophile |
| *NH₂ | NH₂ | -3 | Amine, strong nucleophile |

### 2.4 C-N Coupling Pathways

After chemical feasibility screening, **39 out of 40 coupling pathways are feasible** (only CO₂ + NO₂ is excluded, as both are fully oxidized with no radical character).

**Coupling type classification:**

| Coupling Type | Mechanism | Representative Pathway | Expected Product |
|--------------|-----------|----------------------|-----------------|
| Nucleophilic | Nucleophilic N attacks electrophilic C | CO + NH₂ → CONH₂ | Urea precursor |
| Radical | Two radical species combine | CO + NO → CONO | Nitrosyl carbonyl |
| Mixed | No clear nucleophilic/electrophilic distinction | CO₂ + NO → CO₂NO | Mixed product |

**Priority pathways** (based on literature and chemical intuition):
1. **CO + NH₂ → CONH₂** (key step in urea synthesis)
2. **CO + N → CON** (isocyanate-like)
3. **CHO + NH₂ → CHONH₂** (formamide)
4. **CO + NO → CONO** (radical coupling)
5. **COOH + NH₂ → COOHNH₂** (glycine precursor)

### 2.5 Cation Condition Matrix

Each coupling pathway is computed under **5 conditions**:

| Label | Description | Purpose |
|-------|-------------|---------|
| no_cation | Cu + water, no cation | Baseline reference |
| Li_near | Li⁺ at Cu-water interface, bonding with adsorbate | Li⁺ near-field effect |
| Li_far | Li⁺ deep in water layer, far from adsorbate | Li⁺ far-field / indirect effect |
| K_near | K⁺ at Cu-water interface, bonding with adsorbate | K⁺ near-field effect |
| K_far | K⁺ deep in water layer, far from adsorbate | K⁺ far-field / indirect effect |

**Cation effect quantification**: ΔΔG‡ = G‡(with cation) − G‡(no cation)

## 3. Computational Methods

### 3.1 Software and Parameters

- **DFT code**: VASP 6.x (compiled with VTST + TPOT/CP-VASP patches)
- **Functional**: PBE + D3(BJ) dispersion correction
- **Cutoff energy**: ENCUT = 400–520 eV
- **K-points**: Gamma-only (large supercell)
- **Electronic convergence**: EDIFF = 1E-5 eV
- **Smearing**: Gaussian, SIGMA = 0.1 eV

### 3.2 Computational Workflow

The complete workflow for each coupling pathway:

```
Step 1: Model Construction
  Cu(100) slab + dual adsorbates (C-species + N-species) + water layer + cation
  ↓
Step 2: Structure Optimization
  VASP geometry optimization (ISIF=2), bottom Cu layer fixed
  ↓
Step 3: AIMD Equilibration
  NVT ensemble, 300 K, Nosé-Hoover thermostat (SMASS=0)
  5,000–10,000 steps × 1 fs = 5–10 ps
  Purpose: equilibrate water structure and cation position
  ↓
Step 4: Slow-Growth Constrained AIMD (core step)
  Collective variable: C-N interatomic distance
  ICONST file defines the C-N distance constraint
  INCREM = −0.005 Å/step (from ~4.0 Å down to ~1.4 Å)
  Total steps: ~520 constrained steps (NSW = 10,000 including equilibration)
  LBLUEOUT = .TRUE. (output free energy gradient to REPORT file)
  ↓
Step 5: Constant-Potential Correction
  Using TPOT or CP-VASP method
  Two-step procedure:
    (a) Static SCF to determine NELECT (Step 1 INCAR)
    (b) Production run with fixed NELECT (combined with Step 4)
  ↓
Step 6: Data Analysis
  Parse REPORT file → extract free energy profile ΔF(ξ)
  Blue Moon ensemble averaging: ΔF = ∫ ⟨|Z|^(−1/2) · (λ + GkT)⟩_ξ dξ
  Forward barrier = max(ΔF) − ΔF(initial)
  Reverse barrier = max(ΔF) − ΔF(final)
```

### 3.3 Slow-Growth Method

The slow-growth method is a free energy calculation technique based on thermodynamic integration:

- **Principle**: The reaction coordinate ξ (here, the C-N distance) is varied incrementally at each MD step while the constraint force is recorded.
- **ICONST file format**:
  ```
  R C_idx N_idx 0
  ```
  R denotes a distance constraint; C_idx and N_idx are 1-based atom indices of the C and N atoms; 0 indicates the rate is read from INCREM.

- **INCREM file**:
  ```
  -0.005
  ```
  The C-N distance decreases by 0.005 Å per MD step.

- **Output**: The REPORT file contains the Lagrange multiplier λ, the metric tensor factor |Z|^(−1/2), and the geometric correction GkT at each step.

### 3.4 Constant-Potential Methods

Electrochemical reactions occur at constant electrode potential, whereas AIMD simulations operate under constant-charge conditions. A constant-potential correction is therefore required:

**TPOT method**:
- LTPOT = .TRUE.
- TPOTVTARGET: target potential (V, vacuum scale)
- Two-step NELECT determination followed by constant-potential MD

**CP-VASP method**:
- LCEP = .TRUE.
- TARGETMU: target chemical potential (eV, e.g., −4.44 eV corresponds to 0 V vs. SHE)
- Coupled with VASPsol++ implicit solvation

## 4. Expected Results and Analysis

### 4.1 Barrier Comparison

| Analysis Dimension | Expected Output |
|-------------------|----------------|
| Pathway screening | Identify the coupling pathway(s) with the lowest barrier |
| Cation effect | ΔΔG‡ values: barrier reduction or increase due to cation |
| Ion species effect | Differential impact of Li⁺ vs. K⁺ (ionic radius effect) |
| Distance effect | Near-surface vs. bulk-water cation effect (direct vs. indirect) |

### 4.2 Analysis Methods

1. **Free energy profiles ΔF(ξ)**: Extracted from REPORT files, plotted along the C-N distance coordinate
2. **Barrier comparison table**: Systematic comparison across 5 conditions × N pathways
3. **Charge analysis**: Bader charge analysis at the transition state to quantify charge transfer
4. **Structural analysis**: Geometric relationship between cation and adsorbates at the transition state
5. **Solvation structure**: Water reorganization during the coupling process

### 4.3 Anticipated Scientific Findings

- Alkali metal cations lower C-N coupling transition state barriers via **electrostatic stabilization**
- K⁺ may exhibit a stronger effect than Li⁺ (larger ionic radius → more diffuse positive charge → more effective interfacial electric field stabilization)
- The cation effect is **significant at near-surface positions** and **diminishes far from the surface** → evidence of a direct near-field mechanism
- Identification of 1–2 optimal coupling pathways to guide experimental design of nitrogen-containing product synthesis

## 5. Computational Cost Estimate

| Step | CPU-hours per task | Number of tasks | Subtotal |
|------|-------------------|-----------------|----------|
| Structure optimization | ~50 h | 5–25 | ~250–1,250 h |
| AIMD equilibration (5 ps) | ~500 h | 5–25 | ~2,500–12,500 h |
| Slow-growth (10,000 steps) | ~1,000 h | 5–25 | ~5,000–25,000 h |
| **Total** | | | **~8,000–39,000 h** |

(Estimated on 48 cores/node; actual costs depend on HPC configuration.)

**Recommended strategy**:
1. Start with 3–5 priority pathways (CO+NH₂, CO+N, CHO+NH₂, etc.)
2. Expand to additional pathways based on initial results
3. For each pathway, run the no_cation baseline first, then add cation conditions

## 6. Tool Support via CatGO Platform

The entire computational workflow is integrated into the CatGO platform:

| Step | CatGO Tool | Description |
|------|-----------|-------------|
| Reaction network enumeration | `catgo_cn_coupling_network` | Auto-enumerate all C-N coupling paths + ICONST templates |
| Dual adsorbate modeling | `catgo_place_dual_adsorbates` | Auto site selection, distance control, face-to-face geometry |
| Water layer construction | `catgo_water_layer` | Explicit water layer with density control |
| Cation placement | `catgo_add_atom` | Near-surface or bulk-water positioning |
| VASP input generation | `catgo_vasp_generate` | Supports slow-growth + TPOT/CP-VASP |
| Workflow creation | `catgo_workflow` | DAG workflow: opt → MD → slow-growth |
| Result analysis | SlowGrowthPane | REPORT file parsing + barrier extraction |

**Usage**: Describe the research goal in natural language within CatBot, and the AI assistant will automatically invoke these tools to complete model construction, input generation, and workflow creation.
