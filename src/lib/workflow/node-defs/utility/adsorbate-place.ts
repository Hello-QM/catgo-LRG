import type { NodeDefinition } from '../../workflow-types'
import { ADSORBATE_PRESET_GROUPS } from '$lib/api/adsorbate'

// Build species dropdown options from the same JSON the viewer + backend
// engine read (server/data/adsorbates.json). This guarantees that when the
// user adds an adsorbate to that file it shows up everywhere — workflow node
// dropdown, MCP `list_presets`, viewer panel, backend placement engine —
// without three independent hand-maintained lists drifting apart.
const _species_options: { label: string; value: string }[] = [
  ...ADSORBATE_PRESET_GROUPS.flatMap((group) =>
    group.presets.map((p) => ({
      label: `${p.display_formula ?? p.formula} (${p.name}) — ${group.label}`,
      value: p.formula,
    })),
  ),
  { label: `Custom`, value: `custom` },
]

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
      options: _species_options,
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
