import type { NodeDefinition } from '../../workflow-types'

export const QCHEM_STATIC_NODE: NodeDefinition = {
  type: `qchem_static`,
  label: `Q-Chem Single Point`,
  color: `#7c3aed`,
  icon: `\u{1F9EA}`,
  category: `Calculation`,
  description: `Q-Chem single-point energy calculation`,
  inputs: [`structure`],
  outputs: [`energy`],
  default_params: { method: `B3LYP`, basis: `6-31G*`, charge: 0, multiplicity: 1, solvent_method: `none`, solvent: `` },
  help_text: `**Q-Chem Single Point** \u2014 Compute energy and properties at fixed geometry using Q-Chem.

Supports DFT, HF, and correlated methods. Use for accurate molecular energies, excited-state calculations (EOM-CCSD), or solvation studies.

**Solvation:** PCM for equilibrium solvation, SMD for free energies of solvation.`,
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
      help: `Level of theory. B3LYP general-purpose, \u03C9B97X-V includes dispersion, EOM-CCSD for excited states.`,
    },
    {
      key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G*`, group: `Method`,
      options: [
        { label: `6-31G*`, value: `6-31G*` },
        { label: `6-311+G(2d,p)`, value: `6-311+G(2d,p)` },
        { label: `cc-pVTZ`, value: `cc-pVTZ` },
        { label: `def2-TZVP`, value: `def2-TZVP` },
      ],
      help: `Basis set. 6-31G* is standard; def2-TZVP recommended for production.`,
    },
    {
      key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
      min: -10, max: 10, step: 1,
      help: `Total molecular charge.`,
    },
    {
      key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
      min: 1, max: 12, step: 1,
      help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
    },
    {
      key: `solvent_method`, label: `Solvent Method`, type: `select`, default: `none`, group: `Solvation`,
      options: [
        { label: `None (gas phase)`, value: `none` },
        { label: `PCM`, value: `PCM` },
        { label: `SMD`, value: `SMD` },
      ],
      help: `Implicit solvation model. PCM for dielectric screening, SMD for free energies of solvation.`,
    },
    {
      key: `solvent`, label: `Solvent`, type: `string`, default: ``, group: `Solvation`,
      show_if: { key: `solvent_method`, values: [`PCM`, `SMD`] },
      help: `Solvent name (e.g. "water", "acetonitrile", "toluene"). Leave empty for default (water).`,
    },
  ],
}
