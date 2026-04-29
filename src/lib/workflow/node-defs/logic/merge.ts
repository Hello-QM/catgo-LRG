import type { NodeDefinition } from '../../workflow-types'

export const merge: NodeDefinition = {
  type: `merge`,
  label: `Merge / Barrier`,
  color: `#a855f7`,
  icon: `\u2B1B`,
  category: `Logic`,
  description: `Wait for all inputs before continuing`,
  inputs: [`input_a`, `input_b`, `input_c`],
  outputs: [`merged`],
  is_merge: true,
  default_params: {},
  help_text: `**Merge / Barrier Node** — Synchronization point. Waits for ALL connected inputs to complete.`,
  param_schema: [],
}
