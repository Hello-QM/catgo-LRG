import type { NodeDefinition } from '../../workflow-types'

export const surface_energy: NodeDefinition = {
  type: `surface_energy`,
  label: `Surface Energy`,
  color: `#0891b2`,
  icon: `\u{1F4D0}`,
  category: `Analysis`,
  description: `Calculate surface energy via linear extrapolation`,
  inputs: [`slab_energies`],
  outputs: [`surface_energy_result`],
  default_params: { grouping: 'auto', surface_area: null, bulk_energy_per_atom: null },
  help_text: `**Surface Energy Analysis** \u2014 Calculate surface energy (\u03B3) from slab calculations at multiple thicknesses using linear extrapolation.

Fits E\u209B\u2097\u2090\u2098(N) = slope \u00D7 N + intercept, then \u03B3 = intercept / (2A).

**Input:** Connect 2+ slab relaxation nodes with different thicknesses (same facet, same surface area).
**Output:** Surface energy in eV/\u00C5\u00B2 and J/m\u00B2, fitted bulk energy per atom, R\u00B2 fit quality, and E(N) plot data.

The slope gives a self-consistent bulk energy per atom, eliminating errors from separate bulk references.`,
  param_schema: [
    {
      key: `grouping`,
      label: `Facet Grouping`,
      type: `select`,
      options: [
        { value: `auto`, label: `Auto-detect from labels` },
        { value: `none`, label: `Single fit (all data)` },
      ],
      default: `auto`,
      group: `Surface`,
      help: `How to group slabs for separate surface energy calculations. "Auto" parses facet indices from labels like Ni(111)-4L.`,
    },
    {
      key: `surface_area`, label: `Surface Area (\u00C5\u00B2)`, type: `number`, default: null, group: `Surface`,
      help: `Override auto-detected surface area. Leave empty to compute from slab lattice vectors |a \u00D7 b|.`,
    },
    {
      key: `bulk_energy_per_atom`, label: `Bulk E/atom (eV)`, type: `number`, default: null, group: `Reference`,
      help: `Optional bulk energy per atom for comparison with the fitted slope. Not used in \u03B3 calculation.`,
    },
  ],
}
