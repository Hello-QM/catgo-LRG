import type { NodeDefinition } from '../../workflow-types'

export const batch_adsorbate_place: NodeDefinition = {
  type: `batch_adsorbate_place`,
  label: `Batch Adsorbate`,
  color: `#f59e0b`,
  icon: `\u{1F9EA}`,
  category: `Tools`,
  description: `Place adsorbates on multiple slab structures for high-throughput screening`,
  inputs: [`structures`],
  outputs: [`structures`],
  default_params: { adsorbates: `OH`, max_sites_per_struct: 1, site_strategy: `all` },
  help_text: `**Batch Adsorbate Placement** — Places OER/HER/CO2RR intermediates (OH, O, OOH, H, COOH, CO) on multiple structures using pymatgen AdsorbateSiteFinder.`,
  param_schema: [
    { key: `adsorbates`, label: `Adsorbates`, type: `string`, default: `OH`, group: `Adsorbate`,
      help: `Comma-separated: OH, O, OOH, H, H2O, COOH, CO` },
    { key: `max_sites_per_struct`, label: `Max Sites per Structure`, type: `number`,
      default: 1, min: 1, max: 10, group: `Adsorbate` },
    { key: `site_strategy`, label: `Site Strategy`, type: `select`, default: `all`, group: `Adsorbate`,
      options: [
        { label: `All sites`, value: `all` },
        { label: `On-top only`, value: `ontop` },
        { label: `Bridge only`, value: `bridge` },
        { label: `Hollow only`, value: `hollow` },
      ] },
  ],
}
