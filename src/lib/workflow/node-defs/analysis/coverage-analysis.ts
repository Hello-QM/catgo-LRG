import type { NodeDefinition } from '../../workflow-types'

export const coverage_analysis: NodeDefinition = {
  type: `coverage_analysis`,
  label: `Coverage Analysis`,
  color: `#8b5cf6`,
  icon: `\u{1F4C8}`,
  category: `Analysis`,
  description: `Compute adsorption energy per adsorbate vs coverage \u03B8 with linear fit`,
  inputs: [`energies`],
  outputs: [`coverage_result`],
  default_params: { reference_coefficient: 0.5, n_surface_sites: 0, species: 'H' },
  help_text: `**Coverage Analysis** \u2014 Plot E_ads/adsorbate vs coverage (\u03B8) with linear fit.

**Formula:** E_ads/X = [E(slab+nX) \u2212 E(slab) \u2212 n \u00D7 coeff \u00D7 E(ref)] / n

**Connect parent nodes:**
1. **Coverage relaxation fan-out** \u2014 batch geo-opt results at different adsorbate counts (auto-detected via fan-out flag)
2. **Clean slab** geo-opt \u2014 relaxed slab without adsorbates (auto-detected as the single parent with the most atoms)
3. **Reference molecule** geo-opt \u2014 e.g. H\u2082 in a box (auto-detected as the single parent with the fewest atoms)

The node auto-detects which parent is which by atom count and fan-out flag.
If no reference molecule is connected, E_ref defaults to 0.`,
  param_schema: [
    {
      key: `reference_coefficient`, label: `Reference Coefficient`, type: `number`,
      default: 0.5, min: 0, max: 2, step: 0.1, group: `Calculation`,
      help: `Stoichiometric coefficient for reference molecule. 0.5 for H (from H\u2082), 1.0 for CO, etc.`,
    },
    {
      key: `species`, label: `Adsorbate Species`, type: `text`,
      default: `H`, group: `Calculation`,
      help: `Element symbol of the adsorbate species (e.g. H, O, N). Used to parse adsorbate count from branch labels.`,
    },
    {
      key: `n_surface_sites`, label: `Surface Sites`, type: `number`,
      default: 0, min: 0, step: 1, group: `Calculation`,
      help: `Number of surface adsorption sites for computing \u03B8 = n/N. Set to 0 to auto-detect from the coverage generator upstream node.`,
    },
  ],
}
