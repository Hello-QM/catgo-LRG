import type { NodeDefinition } from '../../workflow-types'

export const eos_analysis: NodeDefinition = {
  type: `eos_analysis`,
  label: `EOS Analysis`,
  color: `#db2777`,
  icon: `\u{1F4CA}`,
  category: `Analysis`,
  description: `Equation of state fitting`,
  inputs: [`energy_volume_data`],
  outputs: [`eos_fit`],
  default_params: { eos_type: `birch_murnaghan`, npoints: 7, volume_range: 5 },
  help_text: `**EOS Analysis** \u2014 Fit energy-volume data to an equation of state.

Determines equilibrium volume, bulk modulus (B\u2080), and its pressure derivative (B\u2080') by fitting E(V) curves.

**Input:** Energy-volume data from a series of constant-volume calculations at different strains.
**Output:** Fitted parameters (V\u2080, E\u2080, B\u2080, B\u2080') and the fitted E(V) curve.`,
  param_schema: [
    {
      key: `eos_type`, label: `EOS Model`, type: `select`, default: `birch_murnaghan`, group: `Fitting`,
      options: [
        { label: `Birch-Murnaghan (3rd order)`, value: `birch_murnaghan` },
        { label: `Vinet`, value: `vinet` },
        { label: `Murnaghan`, value: `murnaghan` },
      ],
      help: `Equation of state model. Birch-Murnaghan is most widely used; Vinet is better for large compressions.`,
    },
    {
      key: `npoints`, label: `Number of Points`, type: `number`, default: 7, group: `Fitting`,
      min: 5, max: 21, step: 2,
      help: `Number of volume points for E(V) sampling. Use odd number for symmetric range around equilibrium.`,
    },
    {
      key: `volume_range`, label: `Volume Range (\u00B1%)`, type: `number`, default: 5, group: `Fitting`,
      min: 1, max: 20, step: 1,
      help: `Percentage range of volume variation around equilibrium (e.g. 5 = \u00B15%).`,
    },
  ],
}
