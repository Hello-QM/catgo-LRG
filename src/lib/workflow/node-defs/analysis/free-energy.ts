import type { NodeDefinition } from '../../workflow-types'

export const free_energy: NodeDefinition = {
  type: `free_energy`,
  label: `Free Energy`,
  color: `#dc2626`,
  icon: `\u{1F4CA}`,
  category: `Analysis`,
  description: `Free energy diagram (\u0394G)`,
  inputs: [`energies`, `frequencies`, `references`],
  outputs: [`diagram`, `plotly_data`],
  default_params: {
    mode: `adsorbed`, temperature: 298.15, freq_cutoff: 50,
    pressure: 1.0, pathway: `distal`, potential: 0.0,
  },
  help_text: `**Free Energy Diagram** \u2014 Compute and plot \u0394G along a reaction path.\n\nConnect upstream energy, frequency, and reference nodes. The node computes Gibbs free energy corrections (ZPE, entropy) and generates a reaction energy diagram.`,
  param_schema: [
    {
      key: `pathway`, label: `Pathway`, type: `select`, default: `distal`, group: `Thermo`,
      options: [
        { label: `Distal`, value: `distal` },
        { label: `Alternating`, value: `alternating` },
        { label: `Enzymatic`, value: `enzymatic` },
        { label: `Custom`, value: `custom` },
      ],
      help: `Reaction pathway mechanism.`,
    },
    {
      key: `potential`, label: `Applied Potential (V)`, type: `number`, default: 0.0, group: `Thermo`,
      min: -3, max: 3, step: 0.1,
      help: `Applied electrochemical potential (V vs RHE). Each electron-transfer step shifts by -eU.`,
    },
    {
      key: `mode`, label: `Phase`, type: `select`, default: `adsorbed`, group: `Thermo`,
      options: [
        { label: `Adsorbed (surface-bound)`, value: `adsorbed` },
        { label: `Gas Phase (molecule)`, value: `gas` },
      ],
      help: `Treatment of translational/rotational entropy. Adsorbed = vibrational only. Gas = full ideal gas.`,
    },
    {
      key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15, group: `Thermo`,
      min: 100, max: 1500, step: 10,
    },
    {
      key: `freq_cutoff`, label: `Frequency Cutoff (cm\u207B\u00B9)`, type: `number`, default: 50, group: `Thermo`,
      min: 0, max: 200, step: 10,
      help: `Treat frequencies below this as frustrated translations (replace with cutoff value).`,
    },
    {
      key: `pressure`, label: `Pressure (atm)`, type: `number`, default: 1.0, group: `Thermo`,
      min: 0.001, max: 100, step: 0.1,
      help: `Gas pressure for translational entropy (ideal gas). Only applies in gas phase mode.`,
    },
  ],
}
