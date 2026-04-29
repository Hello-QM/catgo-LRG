import type { NodeDefinition } from '../../workflow-types'

import { structure_input } from './structure-input'
import { structure_list_input } from './structure-list-input'
import { slab_gen } from './slab-gen'
import { doping_gen } from './doping-gen'
import { adsorbate_place } from './adsorbate-place'
import { batch_adsorbate_place } from './batch-adsorbate-place'
import { polymer_build } from './polymer-build'
import { polymer_crosslink } from './polymer-crosslink'
import { reference_mol } from './reference-mol'
import { batch_generate } from './batch-generate'
import { batch_slab_gen } from './batch-slab-gen'

export const UTILITY_NODES: Record<string, NodeDefinition> = {
  structure_input,
  structure_list_input,
  slab_gen,
  doping_gen,
  adsorbate_place,
  batch_adsorbate_place,
  polymer_build,
  polymer_crosslink,
  reference_mol,
  batch_generate,
  batch_slab_gen,
}
