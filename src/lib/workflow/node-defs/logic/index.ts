import type { NodeDefinition } from '../../workflow-types'
import { condition } from './condition'
import { loop } from './loop'
import { merge } from './merge'
import { map } from './map'
import { aggregate } from './aggregate'

export const LOGIC_NODES: Record<string, NodeDefinition> = {
  condition,
  loop,
  merge,
  map,
  aggregate,
}
