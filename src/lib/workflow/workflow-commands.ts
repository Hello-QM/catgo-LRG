/**
 * Chat action handler factory for AI tool calls on workflow graphs.
 *
 * Extracted from WorkflowEditor.svelte — pure logic that takes state accessors.
 */

import { NODE_DEFINITIONS } from './node-definitions'
import { uid, snap, NH, GRID, would_create_cycle, type WfNode, type WfEdge } from './graph-model'

export interface WorkflowCommandState {
  get_nodes(): WfNode[]
  get_edges(): WfEdge[]
  set_nodes(nodes: WfNode[]): void
  set_edges(edges: WfEdge[]): void
  push_history(): void
  schedule_save(): void
  ensure_workflow(): Promise<void>
  show_run_dialog(): void
  handle_pause(): Promise<void>
  clear_selection(): void
}

export function create_workflow_action_handler(state: WorkflowCommandState) {
  return async (action: string, params: Record<string, unknown>): Promise<string> => {
    switch (action) {
      case `add_node`: {
        const node_type = params.node_type as string
        const def = NODE_DEFINITIONS[node_type]
        if (!def) return `Unknown node type: ${node_type}. Valid types: ${Object.keys(NODE_DEFINITIONS).join(`, `)}`
        await state.ensure_workflow()
        const id = uid()
        const nodes = state.get_nodes()
        // Place at next available position
        const max_y = nodes.length > 0 ? Math.max(...nodes.map(n => n.y)) : 0
        const new_node = {
          id,
          type: node_type,
          x: snap(100),
          y: snap(max_y + NH + GRID * 3),
          params: { ...def.default_params },
        }
        state.set_nodes([...nodes, new_node])
        state.push_history()
        state.schedule_save()
        return `Added ${def.label} node (id: ${id})`
      }
      case `remove_node`: {
        const node_id = params.node_id as string
        const nodes = state.get_nodes()
        const node = nodes.find(n => n.id === node_id)
        if (!node) return `Node not found: ${node_id}`
        state.set_nodes(nodes.filter(n => n.id !== node_id))
        state.set_edges(state.get_edges().filter(e => e.from !== node_id && e.to !== node_id))
        state.clear_selection()
        state.push_history()
        state.schedule_save()
        const def = NODE_DEFINITIONS[node.type]
        return `Removed ${def?.label ?? node.type} node (${node_id})`
      }
      case `connect_nodes`: {
        const from_id = params.from_node_id as string
        const to_id = params.to_node_id as string
        const nodes = state.get_nodes()
        const edges = state.get_edges()
        const from_node = nodes.find(n => n.id === from_id)
        const to_node = nodes.find(n => n.id === to_id)
        if (!from_node) return `Source node not found: ${from_id}`
        if (!to_node) return `Target node not found: ${to_id}`
        if (would_create_cycle(nodes, edges, from_id, to_id)) return `Cannot connect: would create a cycle`
        const exists = edges.some(e => e.from === from_id && e.to === to_id)
        if (exists) return `Edge already exists between ${from_id} and ${to_id}`
        // Resolve handle names: accept named handles (e.g. "structure") or positional ("out-0")
        const from_def = NODE_DEFINITIONS[from_node.type]
        const to_def = NODE_DEFINITIONS[to_node.type]
        const raw_from_h = (params.from_handle as string | undefined) ?? ``
        const raw_to_h = (params.to_handle as string | undefined) ?? ``
        const from_h_idx = from_def?.outputs ? from_def.outputs.indexOf(raw_from_h) : -1
        const to_h_idx = to_def?.inputs ? to_def.inputs.indexOf(raw_to_h) : -1
        const fromH = raw_from_h.startsWith(`out-`) ? raw_from_h : `out-${from_h_idx >= 0 ? from_h_idx : 0}`
        const toH = raw_to_h.startsWith(`in-`) ? raw_to_h : `in-${to_h_idx >= 0 ? to_h_idx : 0}`
        const edge_id = `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        state.set_edges([...edges, { id: edge_id, from: from_id, to: to_id, fromH, toH }])
        state.push_history()
        state.schedule_save()
        return `Connected ${from_node.type} \u2192 ${to_node.type} (${fromH} \u2192 ${toH})`
      }
      case `set_params`: {
        const node_id = params.node_id as string
        const new_params = params.params as Record<string, unknown>
        const nodes = state.get_nodes()
        const idx = nodes.findIndex(n => n.id === node_id)
        if (idx < 0) return `Node not found: ${node_id}`
        const updated = [...nodes]
        updated[idx] = { ...updated[idx], params: { ...updated[idx].params, ...new_params } }
        state.set_nodes(updated)
        state.push_history()
        state.schedule_save()
        return `Updated parameters on ${nodes[idx].type}: ${Object.keys(new_params).join(`, `)}`
      }
      case `run`: {
        state.show_run_dialog()
        return `Opened run configuration dialog. The user needs to configure HPC settings and confirm.`
      }
      case `pause`: {
        await state.handle_pause()
        return `Workflow paused`
      }
      default:
        return `Unknown action: ${action}`
    }
  }
}
