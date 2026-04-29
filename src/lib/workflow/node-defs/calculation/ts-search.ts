import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  orca_only, sella_show, mlp_only,
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
  default_params: { system_type: `molecular`, software: `sella`, calculator: `xtb`, calculator_method: `GFN2-xTB`, ENCUT: 520, EDIFF: `1e-5`, kpoints: `1×1×1`, fmax: 0.01, max_steps: 500, order: 1, delta: 0.01, gamma: 0.4, method: `r2SCAN-3c`, basis: `6-31G`, nimages: 8, spring_k: 0.1, neb_cycles: 100, charge: 0, multiplicity: 1 },
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
        ],
      },
      {
        key: `calculator_method`, label: `xTB Method`, type: `select`, default: `GFN2-xTB`, group: `Calculator`,
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
    // ── ORCA NEB-TS params ──
    ...orca_only([
      {
        key: `method`, label: `Method`, type: `select`, default: `r2SCAN-3c`, group: `Quantum`,
        options: [
          { label: `B3LYP`, value: `B3LYP` },
          { label: `PBE`, value: `PBE` },
          { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
        ],
      },
      {
        key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
        options: [
          { label: `6-31G`, value: `6-31G` },
          { label: `6-311G`, value: `6-311G` },
          { label: `cc-pVDZ`, value: `cc-pVDZ` },
        ],
      },
      {
        key: `nimages`, label: `Number of Images`, type: `number`, default: 8, group: `NEB`, min: 4, max: 20,
        help: `NEB images between reactant/product. 8-12 typical; more=smoother path.`,
      },
      {
        key: `spring_k`, label: `Spring Constant`, type: `number`, default: 0.1, group: `NEB`, min: 0.01, max: 1.0, step: 0.01,
        help: `Spring constant for NEB images. 0.01-0.2 typical.`,
      },
      {
        key: `neb_cycles`, label: `Max NEB Iterations`, type: `number`, default: 100, group: `NEB`, min: 10, max: 500,
        help: `Maximum NEB optimization iterations.`,
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
