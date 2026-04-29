import type { NodeDefinition } from '../../workflow-types'

export const QCHEM_TS_NODE: NodeDefinition = {
  type: `qchem_ts`,
  label: `Q-Chem TS Search`,
  color: `#7c3aed`,
  icon: `\u{1F9EA}`,
  category: `Calculation`,
  description: `Q-Chem transition state search`,
  inputs: [`structure`],
  outputs: [`structure`, `energy`],
  default_params: { method: `B3LYP`, basis: `6-31G*`, charge: 0, multiplicity: 1, solvent_method: `none`, solvent: ``, geom_opt_max_cycles: 200, convergence: `default`, ts_method: `QST2` },
  help_text: `**Q-Chem Transition State Search** \u2014 Locate first-order saddle points on the potential energy surface.

**QST2:** Requires reactant and product geometries (interpolates to find TS).
**QST3:** Requires reactant, product, and initial TS guess.
**FSM:** Freezing string method \u2014 growing string between endpoints.`,
  param_schema: [
    {
      key: `method`, label: `Method`, type: `select`, default: `B3LYP`, group: `Method`,
      options: [
        { label: `HF`, value: `HF` },
        { label: `B3LYP`, value: `B3LYP` },
        { label: `PBE`, value: `PBE` },
        { label: `\u03C9B97X-V`, value: `wB97X-V` },
        { label: `EOM-CCSD`, value: `EOM-CCSD` },
      ],
      help: `Level of theory.`,
    },
    {
      key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G*`, group: `Method`,
      options: [
        { label: `6-31G*`, value: `6-31G*` },
        { label: `6-311+G(2d,p)`, value: `6-311+G(2d,p)` },
        { label: `cc-pVTZ`, value: `cc-pVTZ` },
        { label: `def2-TZVP`, value: `def2-TZVP` },
      ],
      help: `Basis set.`,
    },
    {
      key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
      min: -10, max: 10, step: 1,
      help: `Total molecular charge.`,
    },
    {
      key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
      min: 1, max: 12, step: 1,
      help: `Spin multiplicity (2S+1).`,
    },
    {
      key: `solvent_method`, label: `Solvent Method`, type: `select`, default: `none`, group: `Solvation`,
      options: [
        { label: `None (gas phase)`, value: `none` },
        { label: `PCM`, value: `PCM` },
        { label: `SMD`, value: `SMD` },
      ],
      help: `Implicit solvation model.`,
    },
    {
      key: `solvent`, label: `Solvent`, type: `string`, default: ``, group: `Solvation`,
      show_if: { key: `solvent_method`, values: [`PCM`, `SMD`] },
      help: `Solvent name.`,
    },
    {
      key: `ts_method`, label: `TS Method`, type: `select`, default: `QST2`, group: `TS Search`,
      options: [
        { label: `QST2 (reactant + product)`, value: `QST2` },
        { label: `QST3 (reactant + product + TS guess)`, value: `QST3` },
        { label: `FSM (freezing string)`, value: `FSM` },
      ],
      help: `Transition state search algorithm. QST2 is most common; FSM for complex reaction paths.`,
    },
    {
      key: `geom_opt_max_cycles`, label: `Max Optimization Cycles`, type: `number`, default: 200, group: `TS Search`,
      min: 10, max: 999, step: 10,
      help: `Maximum number of TS optimization steps.`,
    },
    {
      key: `convergence`, label: `Convergence Criteria`, type: `select`, default: `default`, group: `TS Search`,
      options: [
        { label: `Default`, value: `default` },
        { label: `Tight`, value: `tight` },
        { label: `Very Tight`, value: `very_tight` },
      ],
      help: `Convergence thresholds for TS optimization.`,
    },
  ],
}
