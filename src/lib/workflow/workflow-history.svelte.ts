/**
 * Undo/redo history for workflow graph state.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 */

import type { WfNode, WfEdge } from './graph-model'

export interface WorkflowHistory {
  history: { nodes: WfNode[]; edges: WfEdge[] }[]
  readonly hist_idx: number
  push_history(nodes: WfNode[], edges: WfEdge[]): void
  undo(): { nodes: WfNode[]; edges: WfEdge[] } | null
  redo(): { nodes: WfNode[]; edges: WfEdge[] } | null
}

export function create_workflow_history(): WorkflowHistory {
  let history = $state<{ nodes: WfNode[]; edges: WfEdge[] }[]>([])
  let hist_idx = $state(-1)

  function push_history(nodes: WfNode[], edges: WfEdge[]) {
    const entry = { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) }
    history = [...history.slice(0, hist_idx + 1), entry]
    hist_idx = history.length - 1
  }

  function undo(): { nodes: WfNode[]; edges: WfEdge[] } | null {
    if (hist_idx <= 0) return null
    const prev = history[hist_idx - 1]
    hist_idx--
    return { nodes: JSON.parse(JSON.stringify(prev.nodes)), edges: JSON.parse(JSON.stringify(prev.edges)) }
  }

  function redo(): { nodes: WfNode[]; edges: WfEdge[] } | null {
    if (hist_idx >= history.length - 1) return null
    const next = history[hist_idx + 1]
    hist_idx++
    return { nodes: JSON.parse(JSON.stringify(next.nodes)), edges: JSON.parse(JSON.stringify(next.edges)) }
  }

  return {
    get history() { return history },
    get hist_idx() { return hist_idx },
    push_history,
    undo,
    redo,
  }
}
