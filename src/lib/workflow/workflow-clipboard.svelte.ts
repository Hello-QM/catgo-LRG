/**
 * Clipboard (copy/paste/delete) for workflow nodes and edges.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 */

import type { WfNode, WfEdge } from './graph-model'
import { clone_for_paste } from './graph-model'

export interface WorkflowClipboardState {
  nodes: WfNode[]
  edges: WfEdge[]
}

export interface WorkflowClipboardAPI {
  readonly clipboard: WorkflowClipboardState | null
  copy_selected(
    nodes: WfNode[],
    sel_nodes: Set<string>,
    edges: WfEdge[],
  ): void
  paste(
    nodes: WfNode[],
    edges: WfEdge[],
  ): { nodes: WfNode[]; edges: WfEdge[]; new_sel: Set<string> } | null
  delete_selected(
    nodes: WfNode[],
    edges: WfEdge[],
    sel_nodes: Set<string>,
    sel_edge: string | null,
  ): { nodes: WfNode[]; edges: WfEdge[]; sel_nodes: Set<string>; sel_edge: string | null; changed: boolean }
}

export function create_workflow_clipboard(): WorkflowClipboardAPI {
  let clipboard = $state<WorkflowClipboardState | null>(null)

  function copy_selected(
    nodes: WfNode[],
    sel_nodes: Set<string>,
    edges: WfEdge[],
  ) {
    if (sel_nodes.size === 0) return
    const sn = nodes.filter(n => sel_nodes.has(n.id))
    const se = edges.filter(e => sel_nodes.has(e.from) && sel_nodes.has(e.to))
    clipboard = { nodes: JSON.parse(JSON.stringify(sn)), edges: JSON.parse(JSON.stringify(se)) }
  }

  function paste(
    nodes: WfNode[],
    edges: WfEdge[],
  ): { nodes: WfNode[]; edges: WfEdge[]; new_sel: Set<string> } | null {
    if (!clipboard) return null
    const cloned = clone_for_paste(clipboard)
    return {
      nodes: [...nodes, ...cloned.nodes],
      edges: [...edges, ...cloned.edges],
      new_sel: new Set(cloned.nodes.map(n => n.id)),
    }
  }

  function delete_selected(
    nodes: WfNode[],
    edges: WfEdge[],
    sel_nodes: Set<string>,
    sel_edge: string | null,
  ): { nodes: WfNode[]; edges: WfEdge[]; sel_nodes: Set<string>; sel_edge: string | null; changed: boolean } {
    if (sel_edge) {
      return {
        nodes,
        edges: edges.filter(e => e.id !== sel_edge),
        sel_nodes,
        sel_edge: null,
        changed: true,
      }
    }
    if (sel_nodes.size === 0) {
      return { nodes, edges, sel_nodes, sel_edge, changed: false }
    }
    return {
      nodes: nodes.filter(n => !sel_nodes.has(n.id)),
      edges: edges.filter(e => !sel_nodes.has(e.from) && !sel_nodes.has(e.to)),
      sel_nodes: new Set(),
      sel_edge: null,
      changed: true,
    }
  }

  return {
    get clipboard() { return clipboard },
    copy_selected,
    paste,
    delete_selected,
  }
}
