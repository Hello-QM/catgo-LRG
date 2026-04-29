import type { NodeDefinition } from '../../workflow-types'

export const doping_gen: NodeDefinition = {
  type: `doping_gen`,
  label: `Doping Gen`,
  color: `#059669`,
  icon: `\u{1F9EA}`,
  category: `Tools`,
  description: `Generate doped surface variants`,
  inputs: [`structure`],
  outputs: [`structures`],
  default_params: {
    mode: `simple`,
    dopant: `Fe`,
    count: 1,
    target_element: ``,
    enumerate: false,
    max_configs: 50,
    deduplicate: true,
    groups: `[]`,
  },
  help_text: `**Doping Generator** — Create substitutionally doped surface variants.

Replaces surface atoms with dopant elements. **Simple mode**: single dopant/host pair. **Combinatorial mode**: multiple substitution groups for high-throughput screening.`,
  param_schema: [
    {
      key: `mode`, label: `Mode`, type: `select`, default: `simple`, group: `Doping`,
      options: [
        { label: `Simple (one dopant)`, value: `simple` },
        { label: `Combinatorial (multi-group)`, value: `combinatorial` },
      ],
      help: `Simple: single dopant into one host element. Combinatorial: multiple substitution groups for screening.`,
    },
    // Simple mode params
    {
      key: `dopant`, label: `Dopant Element`, type: `periodic`, default: `Fe`, group: `Doping`,
      show_if: { key: `mode`, values: [`simple`] },
      help: `Element to substitute into the structure.`,
    },
    {
      key: `target_element`, label: `Host Element`, type: `periodic`, default: ``, group: `Doping`,
      show_if: { key: `mode`, values: [`simple`] },
      help: `Element to replace. Leave empty to auto-detect (most common non-ligand element).`,
    },
    {
      key: `target_indices`, label: `Specific Site Indices`, type: `string`, default: ``, group: `Doping`,
      show_if: { key: `mode`, values: [`simple`] },
      help: `Comma-separated atom indices to dope (e.g. "3, 7, 15"). Leave empty to auto-select by element. Use "Select Sites in 3D" button above to pick visually.`,
    },
    {
      key: `count`, label: `Number of Substitutions`, type: `number`, default: 1, group: `Doping`,
      show_if: { key: `mode`, values: [`simple`] },
      min: 1, max: 10, step: 1,
      help: `How many host atoms to replace with dopant. Ignored if specific sites are selected.`,
    },
    {
      key: `enumerate`, label: `Enumerate All Configurations`, type: `boolean`, default: false, group: `Doping`,
      show_if: { key: `mode`, values: [`simple`] },
      help: `Generate all unique doping configurations (combinatorial). Results in multiple structures.`,
    },
    {
      key: `max_configs`, label: `Max Configurations`, type: `number`, default: 50, group: `Doping`,
      min: 1, max: 500, step: 10,
      show_if: { key: `enumerate`, values: [`true`, true] },
      help: `Maximum number of unique configurations to generate.`,
    },
    {
      key: `deduplicate`, label: `Symmetry-Aware Deduplication`, type: `boolean`, default: true, group: `Doping`,
      show_if: { key: `enumerate`, values: [`true`, true] },
      help: `Remove symmetry-equivalent configurations (uses spglib).`,
    },
    // Combinatorial mode params
    {
      key: `groups`, label: `Substitution Groups`, type: `doping_groups`, default: `[]`, group: `Doping`,
      show_if: { key: `mode`, values: [`combinatorial`] },
      help: `Each group defines a target element and replacement elements. Total configs = product of all group sizes.`,
    },
    {
      key: `combo_max_configs`, label: `Max Configurations`, type: `number`, default: 50, group: `Doping`,
      show_if: { key: `mode`, values: [`combinatorial`] },
      min: 1, max: 500, step: 10,
      help: `Maximum number of structures to generate.`,
    },
  ],
}
