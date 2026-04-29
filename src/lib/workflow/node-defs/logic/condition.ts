import type { NodeDefinition } from '../../workflow-types'

export const condition: NodeDefinition = {
  type: `condition`,
  label: `Condition`,
  color: `#f59e0b`,
  icon: `\u25C7`,
  category: `Logic`,
  description: `Branch based on condition (convergence check, energy threshold)`,
  inputs: [`input_a`, `input_b`],
  outputs: [`true_out`, `false_out`],
  is_condition: true,
  default_params: { field: `energy_diff`, op: `<`, value: `0.01` },
  help_text: `**Condition Node** — Branching logic.

Evaluates a condition on the result of a parent step and routes the workflow.`,
  param_schema: [
    {
      key: `field`, label: `Field to Check`, type: `select`, default: `energy_diff`, group: `Condition`,
      options: [
        { label: `Energy Difference`, value: `energy_diff` },
        { label: `Max Force`, value: `max_force` },
        { label: `Convergence Flag`, value: `converged` },
        { label: `Number of Steps`, value: `n_steps` },
      ],
    },
    {
      key: `op`, label: `Operator`, type: `select`, default: `<`, group: `Condition`,
      options: [
        { label: `< (less than)`, value: `<` },
        { label: `> (greater than)`, value: `>` },
        { label: `== (equals)`, value: `==` },
        { label: `!= (not equals)`, value: `!=` },
      ],
    },
    { key: `value`, label: `Threshold`, type: `string`, default: `0.01`, group: `Condition` },
  ],
}
