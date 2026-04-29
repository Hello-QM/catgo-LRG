import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only, cp2k_only, orca_only, xtb_only, gaussian_only, mlp_only,
  INCAR_COMMON, KPOINTS_PARAM,
  VASP_ELECTRONIC_PARAMS, VASP_OUTPUT_PARAMS, VASP_PARALLELIZATION_PARAMS,
  VASP_DISPERSION_PARAMS, VASP_ADVANCED_PARAMS,
  CP2K_DFT_PARAMS, ORCA_QC_PARAMS, XTB_METHOD_PARAMS, GAUSSIAN_QC_PARAMS,
} from '../common'

export const SINGLE_POINT_NODE: NodeDefinition = {
  type: `single_point`,
  label: `Single Point`,
  color: `#6366f1`,
  icon: `\u{1F52C}`,
  category: `Calculation`,
  description: `Single-point energy calculation`,
  inputs: [`structure`],
  outputs: [`energy`, `dos`, `band`],
  default_params: {
    system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, PREC: `Accurate`,
    ALGO: `Fast`, ISMEAR: -5, SIGMA: 0.05, LREAL: `Auto`, NELM: 200, ISPIN: 1, MAGMOM: ``,
    kpoints: `4×4×4`,
    LORBIT: 11, LWAVE: false, LCHARG: true, LAECHG: false,
    NPAR: 0, KPAR: 0, NCORE: 4,
    IVDW: 0, LDIPOL: false, IDIPOL: 3,
    NBANDS: 0, NEDOS: 301, ISTART: 0, ICHARG: 0,
  },
  help_text: `**Single Point Calculation** — Compute energy at fixed geometry.

Choose system type, then select a compatible software.

Use after geometry optimization for accurate energies, or as input for DOS/band structure analysis.`,
  param_schema: [
    {
      key: `system_name`, label: `System Name`, type: `string`, default: ``,
      group: `General`,
      help: `Name for this system (e.g. "slab+OH"). Propagated to downstream Gibbs Energy node for the free energy diagram.`,
    },
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
        { label: `CP2K`, value: `cp2k` },
        { label: `ORCA`, value: `orca` },
        { label: `Gaussian`, value: `gaussian` },
        { label: `xTB`, value: `xtb` },
        { label: `ML Potential`, value: `mlp` },
      ],
      help: `Calculation engine to use. Options are filtered by system type.`,
    },
    // ── MLP params ──
    ...mlp_only([
      {
        key: `model`, label: `ML Model`, type: `select`, default: `MACE`, group: `MLP`,
        options: [
          { label: `MACE (Universal)`, value: `MACE` },
          { label: `CHGNet`, value: `CHGNet` },
          { label: `M3GNet`, value: `M3GNet` },
        ],
        help: `Machine learning potential to use for energy/force evaluation.`,
      },
    ]),
    // ── VASP params ──
    ...vasp_only([
      ...INCAR_COMMON,
      KPOINTS_PARAM,
      ...VASP_ELECTRONIC_PARAMS,
      ...VASP_OUTPUT_PARAMS,
      ...VASP_DISPERSION_PARAMS,
      ...VASP_PARALLELIZATION_PARAMS,
      ...VASP_ADVANCED_PARAMS,
    ]),
    // ── CP2K params ──
    ...cp2k_only(CP2K_DFT_PARAMS),
    // ── ORCA params ──
    ...orca_only(ORCA_QC_PARAMS),
    // ── Gaussian params ──
    ...gaussian_only(GAUSSIAN_QC_PARAMS),
    // ── xTB params ──
    ...xtb_only(XTB_METHOD_PARAMS),
  ],
}
