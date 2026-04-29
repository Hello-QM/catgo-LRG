import type { NodeDefinition } from '../../workflow-types'

export const polymer_build: NodeDefinition = {
  type: `polymer_build`,
  label: `Polymer Build`,
  color: `#f97316`,
  icon: `\u{1F9F6}`,
  category: `Tools`,
  description: `Build polymer chain structure`,
  inputs: [],
  outputs: [`structure`],
  default_params: {
    polymer_type: `PE`,
    chain_length: 100,
    tacticity: `atactic`,
    force_field: `opls`,
    density: 0.85,
    n_chains: 1,
    seed: 42,
  },
  help_text: `**Polymer Chain Builder** — Generate polymer chains for MD simulation.`,
  param_schema: [
    {
      key: `polymer_type`, label: `Polymer Type`, type: `select`, default: `PE`, group: `Polymer`,
      options: [
        { label: `Polyethylene (PE)`, value: `PE` },
        { label: `Polypropylene (PP)`, value: `PP` },
        { label: `Polystyrene (PS)`, value: `PS` },
        { label: `PMMA`, value: `PMMA` },
        { label: `PET`, value: `PET` },
        { label: `Nylon-6 (PA6)`, value: `PA6` },
      ],
    },
    {
      key: `chain_length`, label: `Chain Length`, type: `number`, default: 100, group: `Polymer`,
      min: 10, max: 10000, step: 10,
    },
    {
      key: `tacticity`, label: `Tacticity`, type: `select`, default: `atactic`, group: `Polymer`,
      options: [
        { label: `Isotactic`, value: `isotactic` },
        { label: `Syndiotactic`, value: `syndiotactic` },
        { label: `Atactic`, value: `atactic` },
      ],
    },
    {
      key: `force_field`, label: `Force Field`, type: `select`, default: `opls`, group: `Force Field`,
      options: [
        { label: `OPLS-AA`, value: `opls` },
        { label: `PCFF`, value: `pcff` },
        { label: `COMPASS`, value: `compass` },
        { label: `Dreiding`, value: `dreiding` },
        { label: `traPPE-UA`, value: `trappe` },
      ],
    },
    {
      key: `density`, label: `Target Density (g/cm\u00B3)`, type: `number`, default: 0.85, group: `Packing`,
      min: 0.1, max: 2.0, step: 0.05,
    },
    {
      key: `n_chains`, label: `Number of Chains`, type: `number`, default: 1, group: `Packing`,
      min: 1, max: 100, step: 1,
    },
    {
      key: `seed`, label: `Random Seed`, type: `number`, default: 42, group: `Advanced`,
      min: 1, max: 999999, step: 1,
    },
  ],
}
