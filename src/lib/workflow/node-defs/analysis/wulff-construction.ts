import type { NodeDefinition } from '../../workflow-types'

export const wulff_construction: NodeDefinition = {
  type: `wulff_construction`,
  label: `Wulff Construction`,
  color: `#8b5cf6`,
  icon: `\u{1F48E}`,
  category: `Analysis`,
  description: `Predict nanoparticle morphology from surface energies`,
  inputs: [`surface_energy_result`],
  outputs: [`wulff_result`],
  default_params: { lattice_constant: null },
  help_text: `**Wulff Construction** \u2014 Predict the equilibrium shape of a crystalline nanoparticle from surface energies.

Uses pymatgen WulffShape to compute area fractions, volume, surface area, and effective radius.

**Input:** Connect a **Surface Energy** analysis node (must have per-facet results from \u22652 facets).
**Output:** Facet area fractions, dominant facet, shape properties.

The Wulff theorem states that facets with lower surface energy occupy larger areas on the equilibrium crystal shape.`,
  param_schema: [
    {
      key: `lattice_constant`, label: `Lattice Constant (\u00C5)`, type: `number`, default: null, group: `Structure`,
      help: `Override auto-detected lattice constant. Leave empty to extract from parent structure data.`,
    },
  ],
}
