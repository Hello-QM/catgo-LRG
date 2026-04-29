import type { NodeDefinition } from '../../workflow-types'

export const adsorption_energy: NodeDefinition = {
  type: `adsorption_energy`,
  label: `Adsorption Energy`,
  color: `#dc2626`,
  icon: `\u{1F9F2}`,
  category: `Analysis`,
  description: `Calculate adsorption energy from slab, slab+adsorbate, and reference energies`,
  inputs: [`energies`],
  outputs: [`adsorption_result`],
  default_params: { reference_coefficient: 0.5, include_zpe: true },
  help_text: `**Adsorption Energy** \u2014 Compute E\u2090\u2091\u209B = E(slab+ads) \u2212 E(slab) \u2212 coeff \u00D7 E(ref)

**Connect 2 or 3 parent Geo Opt nodes:**
1. **Slab + adsorbate** relaxation (most atoms \u2192 auto-detected)
2. **Clean slab** relaxation (fewer atoms)
3. **Reference molecule** relaxation (optional, e.g. H\u2082 in a box)

**ZPE Correction (optional):**
Connect Frequency/Vibration nodes as additional parents to apply ZPE correction:
- E\u2090\u2091\u209B(ZPE) = E\u2090\u2091\u209B + ZPE(slab+ads) \u2212 ZPE(slab) \u2212 coeff \u00D7 ZPE(ref)
- Freq nodes are paired with their corresponding relaxation by atom count

**Example:** H adsorption on Ni(111) with ZPE
- 3 Geo Opt nodes (slab+H, slab, H\u2082) + 2 Freq nodes (slab+H vibrations, H\u2082 vibrations)
- E\u2090\u2091\u209B(ZPE) = E(Ni-slab+H) \u2212 E(Ni-slab) \u2212 0.5\u00D7E(H\u2082) + ZPE(H*) \u2212 0.5\u00D7ZPE(H\u2082)`,
  param_schema: [
    {
      key: `reference_coefficient`, label: `Reference Coefficient`, type: `number`,
      default: 0.5, min: 0, max: 2, step: 0.1, group: `Calculation`,
      help: `Stoichiometric coefficient for the reference molecule. Use 0.5 for H (from H\u2082), 1.0 for CO, OH, etc.`,
    },
    {
      key: `include_zpe`, label: `Include ZPE Correction`, type: `boolean`,
      default: true, group: `Calculation`,
      help: `Apply zero-point energy correction from connected Frequency/Vibration nodes. If no freq data is available, only the electronic E_ads is computed.`,
    },
  ],
}
