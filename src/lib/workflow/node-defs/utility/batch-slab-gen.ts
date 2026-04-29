import type { NodeDefinition } from '../../workflow-types'

export const batch_slab_gen: NodeDefinition = {
  type: `batch_slab_gen`,
  label: `Batch Slab Gen`,
  color: `#0ea5e9`,
  icon: `\u{1F4CA}`,
  category: `Tools`,
  description: `Generate multiple slabs from one bulk with different (miller, layers) combinations`,
  inputs: [`structure`],
  outputs: [`structures`],
  is_fan_out: true,
  default_params: {
    combinations: `[[1,1,1,4],[1,1,1,6],[1,1,1,8],[1,0,0,4],[1,0,0,6],[1,0,0,8],[1,1,0,4],[1,1,0,6],[1,1,0,8],[2,1,1,4],[2,1,1,6],[2,1,1,8]]`,
    vacuum: 15.0,
    supercell_a: 1,
    supercell_b: 1,
    center_slab: true,
  },
  help_text: `**Batch Slab Gen** — Generate multiple slabs from a single bulk structure for surface energy screening.

Each combination is specified as **[h, k, l, layers]** or **[h, k, l, layers, vacuum]**.

Connect the output to a **Map (Parallel)** node to relax all slabs concurrently.

**Example workflow:**
\`\`\`
Structure Input → Bulk Opt → Batch Slab Gen → Map → Geo Opt (slab) → Aggregate
\`\`\`

The default combinations cover 4 facets (111, 100, 110, 211) at 3 thicknesses (4, 6, 8 layers) = 12 slabs, matching a standard surface energy convergence study.`,
  param_schema: [
    {
      key: `combinations`, label: `Slab Combinations`, type: `text`, default: `[[1,1,1,4],[1,1,1,6],[1,1,1,8],[1,0,0,4],[1,0,0,6],[1,0,0,8],[1,1,0,4],[1,1,0,6],[1,1,0,8],[2,1,1,4],[2,1,1,6],[2,1,1,8]]`,
      group: `Slabs`,
      help: `JSON array of [h, k, l, layers] tuples. Each generates one slab. Optionally add a 5th element for per-slab vacuum: [h,k,l,layers,vacuum].`,
    },
    {
      key: `vacuum`, label: `Default Vacuum (Å)`, type: `number`, default: 15.0, group: `Slabs`,
      min: 5, max: 50, step: 1,
      help: `Vacuum spacing in Å. Applied to all slabs unless overridden per-combo.`,
    },
    {
      key: `supercell_a`, label: `Supercell a`, type: `number`, default: 1, group: `Supercell`,
      min: 1, max: 6, step: 1,
      help: `In-plane supercell multiplier along a-direction.`,
    },
    {
      key: `supercell_b`, label: `Supercell b`, type: `number`, default: 1, group: `Supercell`,
      min: 1, max: 6, step: 1,
      help: `In-plane supercell multiplier along b-direction.`,
    },
    {
      key: `center_slab`, label: `Center Slab`, type: `boolean`, default: true, group: `Supercell`,
      help: `Center the slab in the vacuum region.`,
    },
  ],
}
