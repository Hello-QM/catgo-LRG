import type { NodeDefinition } from '../../workflow-types'

export const aggregate: NodeDefinition = {
  type: `aggregate`,
  label: `Aggregate & Filter`,
  color: `#6366f1`,
  icon: `\u{1F4CA}`,
  category: `Logic`,
  description: `Collect parallel results, compare, and filter top candidates`,
  inputs: [`results`],
  outputs: [`filtered`, `table`],
  is_fan_in: true,
  default_params: {
    sort_by: `energy_per_atom`,
    custom_sort_key: ``,
    sort_order: `ascending`,
    filter_by: ``,
    top_n: 0,
    export_csv: true,
  },
  help_text: `**Aggregate & Filter** — Fan-in node that collects and ranks parallel results.

## How it works

The Aggregate node receives results from all branches spawned by the upstream **Map (Parallel)** node. It builds a comparison table, applies optional filters, sorts, and selects top candidates.

### Processing pipeline
1. **Collect**: gather results from all completed branches
2. **Extract**: pull comparable properties (energy, forces, band gap, etc.)
3. **Filter**: apply optional filter expression to remove unwanted results
4. **Sort**: order by the chosen property
5. **Top-N**: optionally keep only the top N candidates
6. **Export**: save full comparison table as CSV/JSON

### Parameters

- **Sort By**: which property to sort results by. Options include energy per atom, total energy, band gap, formation energy, adsorption energy, max force, or a custom expression.

- **Order**: ascending (lowest first, good for energies) or descending (highest first, good for band gaps).

- **Filter Expression**: Python-like expression to filter results.
  Examples:
  - \`band_gap > 1.5\`
  - \`energy_per_atom < -5.0 and max_force < 0.05\`
  - \`formation_energy < 0\`

- **Keep Top N**: after filtering and sorting, keep only the top N results.
  Set to \`0\` to keep all results that pass the filter.

- **Export CSV**: save the full comparison table as a CSV file in the workflow work directory.

### Outputs
- **filtered**: list of structures that passed all filters (for downstream nodes)
- **table**: full comparison table with all properties (for visualization)

### Usage pattern
\`\`\`
Map (Parallel) → [sub-workflow] → Aggregate & Filter → (next step or export)
\`\`\`

### Summary statistics
The node automatically computes min, max, mean, and standard deviation for each numeric property in the results table.

### Practical examples
- **Dopant screening**: filter by \`formation_energy < 0\`, sort by energy per atom, keep top 5
- **Catalyst screening**: filter by \`adsorption_energy > -2.0 and adsorption_energy < -0.5\`, sort by adsorption energy
- **Band gap screening**: filter by \`band_gap > 1.5 and band_gap < 3.0\`, sort by band gap descending

### Tips
- Use **MLP** pre-screening first (fast), then run DFT on the top N candidates (two-stage workflow)
- Click **View Results Table** after execution to see the full comparison with sortable data, bar charts, and export options
- Combine multiple filter conditions with \`and\`: \`energy_per_atom < -5.0 and max_force < 0.05\``,
  param_schema: [
    {
      key: `sort_by`, label: `Sort By`, type: `select`, default: `energy_per_atom`,
      group: `Ranking`,
      options: [
        { label: `Energy / atom`, value: `energy_per_atom` },
        { label: `Total Energy`, value: `total_energy` },
        { label: `Band Gap`, value: `band_gap` },
        { label: `Formation Energy`, value: `formation_energy` },
        { label: `Adsorption Energy`, value: `adsorption_energy` },
        { label: `Force Max`, value: `max_force` },
        { label: `Volume`, value: `volume` },
        { label: `Magnetic Moment`, value: `magnetic_moment` },
        { label: `Custom`, value: `custom` },
      ],
      help: `Property to sort results by.`,
    },
    {
      key: `custom_sort_key`, label: `Custom Sort Key`, type: `string`, default: ``,
      group: `Ranking`,
      show_if: { key: `sort_by`, values: [`custom`] },
      help: `Property name or expression for custom sorting (e.g. "results.energy / results.n_atoms").`,
    },
    {
      key: `sort_order`, label: `Order`, type: `select`, default: `ascending`,
      group: `Ranking`,
      options: [
        { label: `Ascending (lowest first)`, value: `ascending` },
        { label: `Descending (highest first)`, value: `descending` },
      ],
      help: `Sort direction. Use ascending for energies/forces, descending for band gaps.`,
    },
    {
      key: `filter_by`, label: `Filter Expression`, type: `string`, default: ``,
      group: `Filtering`,
      help: `Python expression to filter results, e.g. "band_gap > 1.5 and energy_per_atom < -5.0". Leave empty to keep all.`,
    },
    {
      key: `top_n`, label: `Keep Top N`, type: `number`, default: 0,
      group: `Filtering`, min: 0, max: 10000, step: 1,
      help: `After filtering and sorting, keep only the top N results. 0 = keep all.`,
    },
    {
      key: `export_csv`, label: `Export CSV`, type: `boolean`, default: true,
      group: `Export`,
      help: `Save the full comparison table as a CSV file in the workflow work directory.`,
    },
  ],
}
