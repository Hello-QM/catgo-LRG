import type { NodeDefinition } from '../../workflow-types'
import {
  vasp_only, cp2k_only,
  INCAR_COMMON, KPOINTS_PARAM,
  VASP_ELECTRONIC_PARAMS, VASP_OUTPUT_PARAMS, VASP_PARALLELIZATION_PARAMS,
  VASP_DISPERSION_PARAMS, VASP_ADVANCED_PARAMS,
  CP2K_DFT_PARAMS,
} from '../common'

export const CELL_OPT_NODE: NodeDefinition = {
  type: `cell_opt`,
  label: `Cell Optimization`,
  color: `#0f766e`,
  icon: `\u{1F4D0}`,
  category: `Calculation`,
  description: `Optimize cell parameters and atomic positions`,
  inputs: [`structure`],
  outputs: [`structure`, `energy`],
  default_params: {
    software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, PREC: `Accurate`,
    ALGO: `Fast`, ISMEAR: 0, SIGMA: 0.05, LREAL: `Auto`, NELM: 200, ISPIN: 1, MAGMOM: ``,
    ISIF: 3, NSW: 200, EDIFFG: -0.01, kpoints: `9×9×9`,
    LORBIT: 11, LWAVE: false, LCHARG: true, LAECHG: false,
    NPAR: 0, KPAR: 0, NCORE: 4,
    IVDW: 0, LDIPOL: false, IDIPOL: 3,
    NBANDS: 0, NEDOS: 301, ISTART: 0, ICHARG: 0,
    double_relax: true,
  },
  help_text: `**Cell Optimization** — Relax both lattice and ionic positions.

Optimizes cell parameters (volume, shape) along with atomic positions.
Use for bulk crystal optimization.`,
  param_schema: [
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
        { label: `CP2K`, value: `cp2k` },
      ],
    },
    // ── VASP params ──
    ...vasp_only([
      ...INCAR_COMMON,
      {
        key: `ISIF`, label: `Relax Mode`, type: `select`, default: 3, group: `INCAR`,
        options: [
          { label: `3 — Full relax (recommended)`, value: 3 },
          { label: `4 — Fix volume, relax shape`, value: 4 },
          { label: `7 — Relax volume only`, value: 7 },
        ],
        help: `Cell degrees of freedom: 3=full relax, 4=fix volume relax shape, 7=volume only.`,
      },
      {
        key: `NSW`, label: `Max Ionic Steps`, type: `number`, default: 200, group: `INCAR`,
        min: 1, max: 999, step: 10,
        help: `Maximum ionic relaxation steps.`,
      },
      {
        key: `EDIFFG`, label: `Force Convergence (eV/Å)`, type: `number`, default: -0.01, group: `INCAR`,
        min: -0.5, max: 0, step: 0.005,
        help: `Force convergence: negative = max force per atom (eV/Å). -0.01 is tight.`,
      },
      { ...KPOINTS_PARAM, default: `9×9×9` },
      ...VASP_ELECTRONIC_PARAMS,
      ...VASP_OUTPUT_PARAMS,
      ...VASP_DISPERSION_PARAMS,
      ...VASP_PARALLELIZATION_PARAMS,
      ...VASP_ADVANCED_PARAMS,
      {
        key: `double_relax`, label: `Double Relaxation`, type: `boolean`, default: true, group: `Advanced`,
        help: `Run twice for better lattice parameter convergence.`,
      },
    ]),
    // ── CP2K params ──
    ...cp2k_only([
      ...CP2K_DFT_PARAMS,
      {
        key: `geo_opt_optimizer`, label: `Optimizer`, type: `select`, default: `BFGS`, group: `CellOpt`,
        options: [
          { label: `BFGS`, value: `BFGS` },
          { label: `LBFGS`, value: `LBFGS` },
        ],
        help: `BFGS=quasi-Newton (fast near minimum), LBFGS=low-memory variant.`,
      },
      {
        key: `geo_opt_max_iter`, label: `Max Steps`, type: `number`, default: 200, group: `CellOpt`,
        min: 10, max: 999, step: 10,
        help: `Maximum cell optimization iterations.`,
      },
    ]),
  ],
}
