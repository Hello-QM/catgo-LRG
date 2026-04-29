import type { NodeDefinition } from '../../workflow-types'

export const QCHEM_OPT_NODE: NodeDefinition = {
  type: `qchem_opt`,
  label: `Q-Chem Optimization`,
  color: `#7c3aed`,
  icon: `\u{1F9EA}`,
  category: `Calculation`,
  description: `Q-Chem geometry optimization`,
  inputs: [`structure`],
  outputs: [`structure`, `energy`],
  default_params: { method: `B3LYP`, basis: `6-31G*`, charge: 0, multiplicity: 1, solvent_method: `none`, solvent: ``, geom_opt_max_cycles: 200, convergence: `default` },
  help_text: `**Q-Chem Optimization** \u2014 Optimize molecular geometry to a local energy minimum.

Uses Q-Chem's built-in optimizer with configurable convergence criteria.`,
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
      help: `Solvent name (e.g. "water", "acetonitrile").`,
    },
    {
      key: `geom_opt_max_cycles`, label: `Max Optimization Cycles`, type: `number`, default: 200, group: `Optimization`,
      min: 10, max: 999, step: 10,
      help: `Maximum number of geometry optimization steps.`,
    },
    {
      key: `convergence`, label: `Convergence Criteria`, type: `select`, default: `default`, group: `Optimization`,
      options: [
        { label: `Default`, value: `default` },
        { label: `Tight`, value: `tight` },
        { label: `Very Tight`, value: `very_tight` },
      ],
      help: `Convergence thresholds for geometry optimization. Tight recommended for small molecules.`,
    },
  ],
}
