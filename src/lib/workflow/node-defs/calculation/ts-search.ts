import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  mlp_only, orca_only, sella_show,
} from '../common'

export const TS_SEARCH_NODE: NodeDefinition = {
  type: `ts_search`,
  label: `TS Search`,
  color: `#dc2626`,
  icon: `\u{26F0}\uFE0F`,
  category: `Calculation`,
  description: `Transition state search`,
  inputs: [`structure`, `structure_product`],
  outputs: [`structure`, `energy`, `frequencies`, `trajectory`],
  default_params: { system_type: `molecular`, software: `sella`, calculator: `xtb`, calculator_method: `GFN2-xTB`, ENCUT: 520, EDIFF: `1e-5`, kpoints: `1×1×1`, fmax: 0.01, max_steps: 500, order: 1, delta: 0.01, gamma: 0.4, method: `r2SCAN-3c`, basis: `6-31G`, nimages: 8, spring_k: 0.1, charge: 0, multiplicity: 1 },
  help_text: `**Transition State Search** — Find saddle points on the PES.

**Software options:**
- **Sella**: Eigenvector-following optimizer (single structure input)
- **ORCA NEB-TS**: Nudged Elastic Band (requires reactant + product)`,
  param_schema: [
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `sella`, group: `Software`,
      options: [
        { label: `Sella`, value: `sella` },
        { label: `ORCA NEB-TS`, value: `orca` },
        { label: `MLP NEB (MACE/CHGNet)`, value: `mlp` },
      ],
    },
    // ── MLP NEB params ──
    ...mlp_only([
      {
        key: `model`, label: `ML Potential`, type: `select`, default: `MACE`, group: `Model`,
        options: [
          { label: `MACE-MP (recommended)`, value: `MACE` },
          { label: `CHGNet`, value: `CHGNet` },
          { label: `M3GNet`, value: `M3GNet` },
        ],
        help: `Machine learning potential for force evaluation on NEB images.`,
      },
      {
        key: `nimages`, label: `Number of Images`, type: `number`, default: 8, group: `NEB`,
        min: 4, max: 20,
        help: `NEB images between reactant/product. 8-12 typical; more = smoother path but slower.`,
      },
      {
        key: `fmax`, label: `Force Convergence (eV/A)`, type: `number`, default: 0.05, group: `NEB`,
        min: 0.01, max: 0.5, step: 0.01,
        help: `Maximum force threshold for NEB convergence. 0.05 for screening, 0.01 for accurate barriers.`,
      },
      {
        key: `max_steps`, label: `Max NEB Steps`, type: `number`, default: 500, group: `NEB`,
        min: 50, max: 5000, step: 50,
        help: `Maximum optimization iterations for NEB path.`,
      },
      {
        key: `climb`, label: `Climbing Image`, type: `select`, default: true, group: `NEB`,
        options: [
          { label: `Yes (recommended)`, value: true },
          { label: `No`, value: false },
        ],
        help: `Climbing image NEB pushes the highest-energy image to the exact saddle point. Recommended for accurate barriers.`,
      },
      {
        key: `mlp_optimizer`, label: `Optimizer`, type: `select`, default: `FIRE`, group: `NEB`,
        options: [
          { label: `FIRE (recommended for NEB)`, value: `FIRE` },
          { label: `LBFGS`, value: `LBFGS` },
        ],
        help: `FIRE is robust for NEB. LBFGS is faster but less stable for stiff paths.`,
      },
    ]),
    // ── Sella params ──
    ...sella_show([
      {
        key: `calculator`, label: `Calculator`, type: `select`, default: `xtb`, group: `Calculator`,
        options: [
          { label: `VASP (DFT, highest accuracy)`, value: `vasp` },
          { label: `xTB (fast, semi-empirical)`, value: `xtb` },
          { label: `MACE-MP`, value: `mace` },
          { label: `CHGNet`, value: `chgnet` },
          { label: `ORCA (QC, molecular)`, value: `orca` },
        ],
      },
      {
        key: `calculator_method`, label: `xTB Method`, type: `select`, default: `GFN2-xTB`, group: `Calculator`,
        show_if: { key: `calculator`, values: [`xtb`] },
        options: [
          { label: `GFN2-xTB (recommended)`, value: `GFN2-xTB` },
          { label: `GFN1-xTB`, value: `GFN1-xTB` },
          { label: `GFN0-xTB`, value: `GFN0-xTB` },
        ],
      },
      {
        key: `ENCUT`, label: `Cutoff Energy (eV)`, type: `number`, default: 520, group: `VASP`,
        min: 200, max: 900, step: 10,
      },
      {
        key: `EDIFF`, label: `SCF Convergence`, type: `select`, default: `1e-5`, group: `VASP`,
        options: [
          { label: `1e-4 (loose)`, value: `1e-4` },
          { label: `1e-5 (standard)`, value: `1e-5` },
          { label: `1e-6 (tight)`, value: `1e-6` },
        ],
      },
      {
        key: `kpoints`, label: `K-Points Grid`, type: `kpoints`, default: `1×1×1`, group: `VASP`,
      },
      {
        key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
        min: 0.001, max: 0.5, step: 0.005,
      },
      {
        key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `Optimizer`,
        min: 10, max: 5000, step: 50,
      },
      {
        key: `order`, label: `Saddle Point Order`, type: `select`, default: 1, group: `Optimizer`,
        options: [
          { label: `1 — First-order (standard TS)`, value: 1 },
          { label: `2 — Second-order`, value: 2 },
        ],
      },
      {
        key: `delta`, label: `Finite Difference Step`, type: `number`, default: 0.01, group: `Advanced`,
        min: 0.001, max: 0.1, step: 0.005,
      },
      {
        key: `gamma`, label: `Damping (gamma)`, type: `number`, default: 0.4, group: `Advanced`,
        min: 0.01, max: 1.0, step: 0.05,
      },
    ]),
    // ── Sella + ORCA params ──
    {
      key: `orca_method`, label: `Method`, type: `select`, default: `B3LYP`, group: `ORCA`,
      show_if: { key: `calculator`, values: [`orca`] },
      options: [
        { label: `HF`, value: `HF` },
        { label: `BP86`, value: `BP86` },
        { label: `BLYP`, value: `BLYP` },
        { label: `PBE`, value: `PBE` },
        { label: `B3LYP`, value: `B3LYP` },
        { label: `PBE0`, value: `PBE0` },
        { label: `B3PW91`, value: `B3PW91` },
        { label: `M06L`, value: `M06L` },
        { label: `M062X`, value: `M062X` },
        { label: `R2SCAN`, value: `R2SCAN` },
        { label: `r2SCAN-3c (no basis needed)`, value: `r2SCAN-3c` },
        { label: `PBEh-3c (no basis needed)`, value: `PBEh-3c` },
        { label: `B2PLYP`, value: `B2PLYP` },
        { label: `CCSD`, value: `CCSD` },
        { label: `MP2`, value: `MP2` },
        { label: `DLPNO-CCSD(T)`, value: `DLPNO-CCSD(T)` },
      ],
    },
    {
      key: `orca_basis`, label: `Basis Set`, type: `select`, default: `def2-SVP`, group: `ORCA`,
      show_if: { key: `calculator`, values: [`orca`] },
      options: [
        { label: `(none — composite method)`, value: `` },
        { label: `STO-3G`, value: `STO-3G` },
        { label: `6-31G`, value: `6-31G` },
        { label: `6-31G*`, value: `6-31G*` },
        { label: `6-311G`, value: `6-311G` },
        { label: `6-311+G**`, value: `6-311+G**` },
        { label: `def2-SVP`, value: `def2-SVP` },
        { label: `def2-TZVP`, value: `def2-TZVP` },
        { label: `def2-TZVPP`, value: `def2-TZVPP` },
        { label: `def2-QZVP`, value: `def2-QZVP` },
        { label: `cc-pVDZ`, value: `cc-pVDZ` },
        { label: `cc-pVTZ`, value: `cc-pVTZ` },
        { label: `cc-pVQZ`, value: `cc-pVQZ` },
        { label: `cc-pVDZ-F12`, value: `cc-pVDZ-F12` },
        { label: `cc-pVTZ-F12`, value: `cc-pVTZ-F12` },
      ],
      help: `Not used for composite methods like r2SCAN-3c.`,
    },
    {
      key: `charge`, label: `Charge`, type: `number`, default: 0, group: `ORCA`,
      show_if: { key: `calculator`, values: [`orca`] },
      help: `Total charge of the system.`,
    },
    {
      key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `ORCA`,
      show_if: { key: `calculator`, values: [`orca`] },
      help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
    },
    // ── ORCA NEB-TS params ──
    ...orca_only([
      {
        key: `method`, label: `Method`, type: `select`, default: `r2SCAN-3c`, group: `Quantum`,
        options: [
          { label: `HF`, value: `HF` },
          { label: `BP86`, value: `BP86` },
          { label: `BLYP`, value: `BLYP` },
          { label: `PBE`, value: `PBE` },
          { label: `B3LYP`, value: `B3LYP` },
          { label: `PBE0`, value: `PBE0` },
          { label: `B3PW91`, value: `B3PW91` },
          { label: `M06L`, value: `M06L` },
          { label: `M062X`, value: `M062X` },
          { label: `R2SCAN`, value: `R2SCAN` },
          { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
          { label: `PBEh-3c`, value: `PBEh-3c` },
          { label: `B2PLYP`, value: `B2PLYP` },
          { label: `CCSD`, value: `CCSD` },
          { label: `MP2`, value: `MP2` },
        ],
        help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
      },
      {
        key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
        options: [
          { label: `(none — composite method)`, value: `` },
          { label: `STO-3G`, value: `STO-3G` },
          { label: `6-31G`, value: `6-31G` },
          { label: `6-31G*`, value: `6-31G*` },
          { label: `6-311G`, value: `6-311G` },
          { label: `6-311+G**`, value: `6-311+G**` },
          { label: `def2-SVP`, value: `def2-SVP` },
          { label: `def2-TZVP`, value: `def2-TZVP` },
          { label: `def2-TZVPP`, value: `def2-TZVPP` },
          { label: `def2-QZVP`, value: `def2-QZVP` },
          { label: `cc-pVDZ`, value: `cc-pVDZ` },
          { label: `cc-pVTZ`, value: `cc-pVTZ` },
          { label: `cc-pVQZ`, value: `cc-pVQZ` },
          { label: `cc-pVDZ-F12`, value: `cc-pVDZ-F12` },
          { label: `cc-pVTZ-F12`, value: `cc-pVTZ-F12` },
        ],
        help: `Basis set. def2 family recommended for ORCA. def2-SVP for screening, def2-TZVP for production.`,
      },
      {
        key: `wavefunction`, label: `Wavefunction`, type: `select`, default: ``, group: `Quantum`,
        options: [
          { label: `Auto (default)`, value: `` },
          { label: `RHF`, value: `RHF` },
          { label: `UHF`, value: `UHF` },
          { label: `ROHF`, value: `ROHF` },
          { label: `RKS`, value: `RKS` },
          { label: `UKS`, value: `UKS` },
          { label: `ROKS`, value: `ROKS` },
        ],
        help: `Wavefunction reference. Auto lets ORCA choose (RHF for HF, RKS for DFT). Use UHF/UKS for open-shell systems.`,
      },
      {
        key: `dispersion`, label: `Dispersion`, type: `select`, default: `none`, group: `SCF`,
        options: [
          { label: `None`, value: `none` },
          { label: `D2`, value: `D2` },
          { label: `D3 (BJ damping)`, value: `D3` },
          { label: `D3BJ (recommended)`, value: `D3BJ` },
          { label: `D3ZERO (zero damping)`, value: `D3ZERO` },
          { label: `D30 (= D3ZERO)`, value: `D30` },
          { label: `D3TZ (triple-ζ params, D3ZERO only)`, value: `D3TZ` },
          { label: `D4 (BJ + ATM, newer)`, value: `D4` },
          { label: `NOVDW (disable D corrections)`, value: `NOVDW` },
        ],
        help: `ORCA simple-input dispersion keyword. D3BJ is the typical default for DFT functionals; D4 is newer and BJ-damped by default. NOVDW explicitly disables dispersion. See ORCA manual §3.4.1.`,
      },
      {
        key: `three_body_dispersion`, label: `Three-body term (ABC/ATM)`, type: `boolean`, default: false, group: `SCF`,
        show_if: { key: `dispersion`, values: [`D2`, `D3`, `D3BJ`, `D3ZERO`, `D30`, `D3TZ`] },
        help: `Adds the three-body Axilrod-Teller-Muto (ATM) term to the route line as 'ABC'. Only relevant for D3 variants — D4 already includes ATM by default.`,
      },
      {
        key: `grid`, label: `Integration Grid`, type: `select`, default: `DefGrid2`, group: `SCF`,
        options: [
          { label: `DefGrid1 (coarse)`, value: `DefGrid1` },
          { label: `DefGrid2 (standard)`, value: `DefGrid2` },
          { label: `DefGrid3 (fine)`, value: `DefGrid3` },
        ],
        help: `DFT integration grid accuracy. DefGrid2 standard, DefGrid3 for tight convergence or meta-GGA.`,
      },
      {
        key: `num_cores`, label: `CPU Cores`, type: `number`, default: 4, group: `Parallelization`,
        min: 1, max: 256, step: 1,
        help: `Number of CPU cores for ORCA parallel execution.`,
      },
      {
        key: `max_core_mb`, label: `Memory per Core (MB)`, type: `number`, default: 4000, group: `Parallelization`,
        min: 256, max: 64000, step: 256,
        help: `Maximum memory per core in MB.`,
      },
      {
        key: `nimages`, label: `Number of Images`, type: `number`, default: 8, group: `NEB`, min: 4, max: 20,
        help: `NEB images between reactant/product. 8-12 typical; more=smoother path.`,
      },
      {
        key: `uno`, label: `Generate Natural Orbitals (UNO)`, type: `boolean`, default: false, group: `Output`,
        help: `Generate natural orbitals and occupation numbers.`,
      },
      {
        key: `uco`, label: `Corresponding Orbitals (UCO)`, type: `boolean`, default: false, group: `Output`,
        help: `Generate corresponding orbitals.`,
      },
      {
        key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
        help: `Total charge of the system.`,
      },
      {
        key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
        help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
      },
    ]),
  ],
}
