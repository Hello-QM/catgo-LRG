import type { NodeDefinition } from '../../workflow-types'

export const loop: NodeDefinition = {
  type: `loop`,
  label: `Loop`,
  color: `#f97316`,
  icon: `\u{1F501}`,
  category: `Logic`,
  description: `Iterate over multiple structures or conditions`,
  inputs: [`collection`],
  outputs: [`each_item`, `completed`],
  is_loop: true,
  default_params: { variable: `structure`, max_iter: 10 },
  help_text: `**Loop Node** — Iterate over a collection.`,
  param_schema: [
    {
      key: `variable`, label: `Loop Variable`, type: `select`, default: `structure`, group: `Loop`,
      options: [
        { label: `Structure`, value: `structure` },
        { label: `Parameter`, value: `parameter` },
      ],
    },
    {
      key: `max_iter`, label: `Max Iterations`, type: `number`, default: 10, group: `Loop`,
      min: 1, max: 100, step: 1,
    },
  ],
}
