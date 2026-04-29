import type { NodeDefinition } from '../../workflow-types'

export const reference_mol: NodeDefinition = {
  type: `reference_mol`,
  label: `Ref Molecule`,
  color: `#475569`,
  icon: `\u2697\uFE0F`,
  category: `Tools`,
  description: `Gas-phase reference molecule energy`,
  inputs: [],
  outputs: [`energy`, `frequencies`],
  default_params: { molecules: `N2,H2,NH3`, box_size: 20.0 },
  help_text: `**Reference Molecule** — Gas-phase energy for thermodynamics.

Calculates the total energy of isolated gas-phase molecules in a large box.`,
  param_schema: [
    {
      key: `molecules`, label: `Molecules`, type: `string`, default: `N2,H2,NH3`, group: `Input`,
      help: `Comma-separated list of molecules to calculate.`,
    },
    {
      key: `box_size`, label: `Box Size (Å)`, type: `number`, default: 20.0, group: `Input`,
      min: 15.0, max: 30.0, step: 1.0,
    },
  ],
}
