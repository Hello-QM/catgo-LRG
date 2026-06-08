import type { NodeDefinition } from '../../workflow-types'

export const slab_gen: NodeDefinition = {
  type: `slab_gen`,
  label: `Slab Gen`,
  color: `#0e7490`,
  icon: `\u{1F52A}`,
  category: `Tools`,
  description: `Cut surface slab from bulk`,
  inputs: [`structure`],
  outputs: [`structure`],
  default_params: { miller: `1,0,0`, layers: 4, vacuum: 15.0, supercell_a: 1, supercell_b: 1, frozen_layers: 0, center_slab: true, primitive: true, enumerate_terminations: false },
  help_text: `**Slab Generator** — Cut a surface from the optimized bulk.

Creates a surface slab by selecting Miller indices, number of layers, and vacuum thickness.`,
  param_schema: [
    {
      key: `miller`, label: `Miller Indices`, type: `string`, default: `1,0,0`, group: `Slab`,
      help: `Surface orientation as h,k,l (e.g. "1,1,0" or "0,0,1").`,
    },
    {
      key: `layers`, label: `Number of Layers`, type: `number`, default: 4, group: `Slab`,
      min: 2, max: 12, step: 1,
      help: `Number of atomic layers in the slab.`,
    },
    {
      key: `vacuum`, label: `Vacuum (Å)`, type: `number`, default: 15.0, group: `Slab`,
      min: 8.0, max: 30.0, step: 1.0,
      help: `Vacuum layer thickness above the surface.`,
    },
    {
      key: `supercell_a`, label: `Supercell a`, type: `number`, default: 1, group: `Slab`,
      min: 1, max: 8, step: 1,
      help: `Repeat along the a lattice direction.`,
    },
    {
      key: `supercell_b`, label: `Supercell b`, type: `number`, default: 1, group: `Slab`,
      min: 1, max: 8, step: 1,
      help: `Repeat along the b lattice direction.`,
    },
    {
      key: `frozen_layers`, label: `Frozen Bottom Layers`, type: `number`, default: 0, group: `Slab`,
      min: 0, max: 8, step: 1,
      help: `Freeze the bottom N layers (Selective Dynamics). Written onto the structure so the fixed atoms are visible in the viewer and inherited by downstream geo_opt/freq. 0 = all atoms free.`,
    },
    {
      key: `center_slab`, label: `Center in Cell`, type: `boolean`, default: true, group: `Slab`,
      help: `Center the slab in the cell (vacuum on both sides).`,
    },
    {
      key: `primitive`, label: `Use Primitive Cell`, type: `boolean`, default: true, group: `Slab`,
      help: `Reduce to primitive cell before cutting.`,
    },
    {
      key: `enumerate_terminations`, label: `Enumerate Terminations`, type: `boolean`, default: false, group: `Slab`,
      help: `Generate all possible surface terminations (results in multiple structures with _fan_out).`,
    },
  ],
}
