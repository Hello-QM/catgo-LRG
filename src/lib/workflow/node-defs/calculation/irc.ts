import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  orca_only,
} from '../common'

export const IRC_NODE: NodeDefinition = {
  type: `irc`,
  label: `IRC`,
  color: `#d946ef`,
  icon: `\u{1F6E4}\uFE0F`,
  category: `Calculation`,
  description: `Intrinsic reaction coordinate`,
  inputs: [`structure`],
  outputs: [`trajectory`, `structures`],
  default_params: { system_type: `molecular`, software: `orca`, method: `r2SCAN-3c`, basis: `6-31G`, max_iterations: 30, initial_displacement_energy: 2.0, charge: 0, multiplicity: 1 },
  help_text: `**IRC** — Trace reaction path from transition state.

Intrinsic Reaction Coordinate (IRC) follows the steepest descent path from a TS to the nearest minima (reactant and product).`,
  param_schema: [
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `orca`, group: `Software`,
      options: [
        { label: `ORCA`, value: `orca` },
      ],
    },
    // ── ORCA IRC params ──
    ...orca_only([
      {
        key: `method`, label: `Method`, type: `select`, default: `r2SCAN-3c`, group: `Quantum`,
        options: [
          { label: `B3LYP`, value: `B3LYP` },
          { label: `PBE`, value: `PBE` },
          { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
        ],
        help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
      },
      {
        key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
        options: [
          { label: `6-31G`, value: `6-31G` },
          { label: `6-311G`, value: `6-311G` },
          { label: `cc-pVDZ`, value: `cc-pVDZ` },
        ],
        help: `Basis set for Gaussian functions. 6-31G is standard.`,
      },
      {
        key: `max_iterations`, label: `Max IRC Steps`, type: `number`, default: 30, group: `IRC`, min: 10, max: 100,
        help: `Maximum IRC path-following steps.`,
      },
      {
        key: `initial_displacement_energy`, label: `Initial Displacement Energy (mEh)`, type: `number`, default: 2.0, group: `IRC`, min: 0.5, max: 10.0, step: 0.5,
        help: `Initial IRC step size (mEh). 2.0 typical.`,
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
