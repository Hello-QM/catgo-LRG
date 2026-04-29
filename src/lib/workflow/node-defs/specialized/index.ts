import type { NodeDefinition } from '../../workflow-types'
import { polymer_md } from './polymer-md'
import { glass_transition } from './glass-transition'
import { polymer_deform } from './polymer-deform'

export const SPECIALIZED_NODES: Record<string, NodeDefinition> = {
  polymer_md,
  glass_transition,
  polymer_deform,
}
