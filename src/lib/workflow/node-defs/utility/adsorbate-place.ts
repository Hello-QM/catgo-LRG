import type { NodeDefinition } from '../../workflow-types'

export const adsorbate_place: NodeDefinition = {
  type: `adsorbate_place`,
  label: `Adsorbate`,
  color: `#7c3aed`,
  icon: `\u{1F3AF}`,
  category: `Tools`,
  description: `Place adsorbate molecule on surface`,
  inputs: [`structure`],
  outputs: [`structure`],
  default_params: { species: `OH`, custom_xyz: ``, site: `all`, height: 2.0, auto_rotate: true, quick_optimize: `none` },
  help_text: `**Adsorbate Placement** — Place molecules on the surface.

Opens CatGo's adsorbate placement tool for interactive site selection.`,
  param_schema: [
    // --- Adsorbate selection ---
    {
      key: `species`, label: `Adsorbate`, type: `select`, default: `OH`, group: `Adsorbate`,
      options: [
        { label: `OH (hydroxyl)`, value: `OH` },
        { label: `O (oxygen)`, value: `O` },
        { label: `OOH (peroxyl)`, value: `OOH` },
        { label: `H (hydrogen)`, value: `H` },
        { label: `H\u2082O (water)`, value: `H2O` },
        { label: `CO (carbon monoxide)`, value: `CO` },
        { label: `COOH (carboxyl)`, value: `COOH` },
        { label: `N\u2082 (nitrogen)`, value: `N2` },
        { label: `NH\u2083 (ammonia)`, value: `NH3` },
        { label: `NO (nitric oxide)`, value: `NO` },
        { label: `N (atomic nitrogen)`, value: `N` },
        { label: `NH (imide)`, value: `NH` },
        { label: `NH\u2082 (amino)`, value: `NH2` },
        { label: `NOH (nitrosyl hydroxide)`, value: `NOH` },
        { label: `NHOH (hydroxylamine)`, value: `NHOH` },
        { label: `HNO (nitroxyl)`, value: `HNO` },
        { label: `NO\u2082 (nitrogen dioxide)`, value: `NO2` },
        { label: `N\u2082O (nitrous oxide)`, value: `N2O` },
        { label: `NO\u2083 (nitrate)`, value: `NO3` },
        { label: `Custom`, value: `custom` },
      ],
      help: `Select adsorbate molecule. Choose "Custom" to specify XYZ coordinates manually.`,
    },
    {
      key: `custom_xyz`, label: `Custom XYZ`, type: `text`, default: ``, group: `Adsorbate`,
      show_if: { key: `species`, values: [`custom`] },
      help: `Paste adsorbate XYZ coordinates. Format: "Element x y z" per line.`,
    },
    // --- Site selection ---
    {
      key: `site`, label: `Adsorption Site`, type: `select`, default: `all`, group: `Placement`,
      options: [
        { label: `All sites (auto-select best)`, value: `all` },
        { label: `On-top`, value: `ontop` },
        { label: `Bridge`, value: `bridge` },
        { label: `FCC Hollow`, value: `fcc` },
        { label: `HCP Hollow`, value: `hcp` },
      ],
      help: `Site type preference. "All" picks the first available site.`,
    },
    {
      key: `height`, label: `Height Offset (Å)`, type: `number`, default: 2.0, group: `Placement`,
      min: 0.5, max: 5.0, step: 0.1,
      help: `Distance above the surface to place the adsorbate binding atom.`,
    },
    {
      key: `auto_rotate`, label: `Auto-Rotate`, type: `boolean`, default: true, group: `Placement`,
      help: `Automatically orient the adsorbate perpendicular to the surface.`,
    },
    // --- Post-placement ---
    {
      key: `quick_optimize`, label: `Quick Optimize After Placement`, type: `select`, default: `none`, group: `Post-placement`,
      options: [
        { label: `None`, value: `none` },
        { label: `UFF (fast, approximate)`, value: `uff` },
        { label: `xTB (GFN2, semi-empirical)`, value: `xtb` },
      ],
      help: `Optionally run a quick local optimization after placing the adsorbate.`,
    },
  ],
}
