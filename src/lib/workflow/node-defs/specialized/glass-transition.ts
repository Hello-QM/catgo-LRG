import type { NodeDefinition } from '../../workflow-types'

export const glass_transition: NodeDefinition = {
  type: `glass_transition`,
  label: `Tg Calculation`,
  color: `#db2777`,
  icon: `\u{1F321}\u{1F4C8}`,
  category: `Tools`,
  description: `Calculate glass transition temperature`,
  inputs: [`structure`],
  outputs: [`tg`, `density_profile`],
  default_params: {
    temp_min: 100,
    temp_max: 500,
    temp_step: 20,
    cooling_rate: 1.0,
  },
  help_text: `**Glass Transition Temperature (Tg)** — Calculate via cooling simulation.`,
  param_schema: [
    {
      key: `temp_min`, label: `Min Temperature (K)`, type: `number`, default: 100, group: `Temperature`,
      min: 50, max: 300, step: 10,
    },
    {
      key: `temp_max`, label: `Max Temperature (K)`, type: `number`, default: 500, group: `Temperature`,
      min: 300, max: 1000, step: 10,
    },
    {
      key: `temp_step`, label: `Temperature Step (K)`, type: `number`, default: 20, group: `Temperature`,
      min: 5, max: 100, step: 5,
    },
    {
      key: `cooling_rate`, label: `Cooling Rate (K/ns)`, type: `number`, default: 1.0, group: `Temperature`,
      min: 0.1, max: 100, step: 0.1,
    },
    {
      key: `equil_steps`, label: `Equilibration Steps`, type: `number`, default: 10000, group: `MD`,
      min: 1000, max: 100000, step: 1000,
    },
    {
      key: `prod_steps`, label: `Production Steps`, type: `number`, default: 5000, group: `MD`,
      min: 500, max: 50000, step: 500,
    },
  ],
}
