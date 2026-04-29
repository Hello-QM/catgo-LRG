import type { NodeDefinition } from '../../workflow-types'

export const polymer_crosslink: NodeDefinition = {
  type: `polymer_crosslink`,
  label: `Crosslink`,
  color: `#ea580c`,
  icon: `\u{1F5E9}`,
  category: `Tools`,
  description: `Create crosslinked polymer network`,
  inputs: [`structure`],
  outputs: [`structure`],
  default_params: {
    crosslinker_type: `sulfur`,
    crosslink_density: 0.05,
    min_distance: 4.0,
    max_distance: 6.0,
    target_atoms: `C,H`,
  },
  help_text: `**Polymer Crosslinking** — Create covalent crosslinks between polymer chains.`,
  param_schema: [
    {
      key: `crosslinker_type`, label: `Crosslinker Type`, type: `select`, default: `sulfur`, group: `Crosslink`,
      options: [
        { label: `Sulfur (vulcanization)`, value: `sulfur` },
        { label: `Peroxide`, value: `peroxide` },
        { label: `Radiation`, value: `radiation` },
        { label: `Epoxy-amine`, value: `epoxy` },
      ],
    },
    {
      key: `crosslink_density`, label: `Crosslink Density`, type: `number`, default: 0.05, group: `Crosslink`,
      min: 0.0, max: 1.0, step: 0.01,
    },
    {
      key: `min_distance`, label: `Min Distance (Å)`, type: `number`, default: 4.0, group: `Geometry`,
      min: 2.0, max: 10.0, step: 0.5,
    },
    {
      key: `max_distance`, label: `Max Distance (Å)`, type: `number`, default: 6.0, group: `Geometry`,
      min: 3.0, max: 15.0, step: 0.5,
    },
    {
      key: `target_atoms`, label: `Target Elements`, type: `text`, default: `C,H`, group: `Selection`,
      help: `Comma-separated elements to crosslink (e.g., 'C,H,S')`,
    },
  ],
}
