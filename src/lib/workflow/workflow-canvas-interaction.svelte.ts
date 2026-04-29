/**
 * Canvas interaction state and handlers for the workflow SVG editor.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 *
 * Manages: drag (node dragging), conn (connection drawing), mouse, pan, zoom,
 * panning, pan_start, box_sel, and all mouse/touch event handlers.
 */

import { NODE_DEFINITIONS } from './node-definitions'
import {
  NW, snap,
  get_nh, get_handle_pos,
  type WfNode, type WfEdge,
} from './graph-model'

export interface DragState {
  id: string
  ox: number
  oy: number
  start: WfNode[]
}

export interface ConnState {
  from_id: string
  from_h: string
  sx: number
  sy: number
}

export interface BoxSelState {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface CanvasInteraction {
  // Reactive state (read by SVG template)
  readonly drag: DragState | null
  readonly conn: ConnState | null
  readonly mouse: { x: number; y: number }
  readonly pan: { x: number; y: number }
  readonly zoom: number
  readonly panning: boolean
  readonly box_sel: BoxSelState | null

  // Direct state setters
  set_pan(p: { x: number; y: number }): void
  set_zoom(z: number): void
  set_conn(c: ConnState | null): void
  reset_view(): void

  // Coordinate transform
  get_svg_pt(e: MouseEvent, svg_el: SVGSVGElement | null): { x: number; y: number }

  // ─── Node drag ───
  on_node_down(
    e: MouseEvent,
    id: string,
    nodes: WfNode[],
    sel_nodes: Set<string>,
    svg_el: SVGSVGElement | null,
  ): { sel_nodes: Set<string>; sel_edge: null }

  // ─── Handle (connection start) ───
  on_handle_down(
    e: MouseEvent,
    node_id: string,
    handle_id: string,
    is_input: boolean,
    nodes: WfNode[],
    edges: WfEdge[],
    svg_el: SVGSVGElement | null,
  ): { edges?: WfEdge[] }

  // ─── SVG canvas mousedown ───
  on_svg_down(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    edges: WfEdge[],
    dist_to_edge: (px: number, py: number, edge: WfEdge) => number,
  ): { sel_nodes?: Set<string>; sel_edge?: string | null }

  // ─── SVG canvas mousemove ───
  on_svg_move(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    nodes: WfNode[],
    sel_nodes: Set<string>,
  ): { nodes?: WfNode[] }

  // ─── SVG canvas mouseup ───
  on_svg_up(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    nodes: WfNode[],
    edges: WfEdge[],
    would_create_cycle: (from_id: string, to_id: string) => boolean,
    on_cycle_warning: (msg: string) => void,
  ): {
    sel_nodes?: Set<string>
    edges?: WfEdge[]
    should_push_history: boolean
    /** click-without-drag on this node id */
    click_node_id?: string
    click_node?: WfNode
  }

  // ─── Wheel zoom handler ───
  handle_wheel(e: WheelEvent, svg_el: SVGSVGElement): void
}

export function create_canvas_interaction(): CanvasInteraction {
  let drag = $state<DragState | null>(null)
  let conn = $state<ConnState | null>(null)
  let mouse = $state({ x: 0, y: 0 })
  let pan = $state({ x: 0, y: 0 })
  let zoom = $state(1)
  let panning = $state(false)
  let pan_start = $state({ x: 0, y: 0 })
  let box_sel = $state<BoxSelState | null>(null)

  function get_svg_pt(e: MouseEvent, svg_el: SVGSVGElement | null): { x: number; y: number } {
    if (!svg_el) return { x: 0, y: 0 }
    const r = svg_el.getBoundingClientRect()
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom }
  }

  function on_node_down(
    e: MouseEvent,
    id: string,
    nodes: WfNode[],
    sel_nodes: Set<string>,
    svg_el: SVGSVGElement | null,
  ): { sel_nodes: Set<string>; sel_edge: null } {
    e.stopPropagation()
    const pt = get_svg_pt(e, svg_el)
    const node = nodes.find(n => n.id === id)
    if (!node) return { sel_nodes, sel_edge: null }

    let new_sel: Set<string>
    if (e.shiftKey) {
      const s = new Set(sel_nodes)
      if (s.has(id)) s.delete(id); else s.add(id)
      new_sel = s
    } else if (!sel_nodes.has(id)) {
      new_sel = new Set([id])
    } else {
      new_sel = sel_nodes
    }

    drag = { id, ox: pt.x - node.x, oy: pt.y - node.y, start: JSON.parse(JSON.stringify(nodes)) }
    return { sel_nodes: new_sel, sel_edge: null }
  }

  function on_handle_down(
    e: MouseEvent,
    node_id: string,
    handle_id: string,
    is_input: boolean,
    nodes: WfNode[],
    edges: WfEdge[],
    svg_el: SVGSVGElement | null,
  ): { edges?: WfEdge[] } {
    e.stopPropagation()
    if (is_input) {
      const existing = edges.find(ed => ed.to === node_id && ed.toH === handle_id)
      if (existing) {
        const new_edges = edges.filter(ed => ed.id !== existing.id)
        const from_node = nodes.find(n => n.id === existing.from)
        if (from_node) {
          const fp = get_handle_pos(from_node, existing.fromH, false)
          conn = { from_id: existing.from, from_h: existing.fromH, sx: fp.x, sy: fp.y }
          mouse = get_svg_pt(e, svg_el)
        }
        return { edges: new_edges }
      }
      return {}
    }
    const node = nodes.find(n => n.id === node_id)
    if (!node) return {}
    const pos = get_handle_pos(node, handle_id, false)
    conn = { from_id: node_id, from_h: handle_id, sx: pos.x, sy: pos.y }
    mouse = get_svg_pt(e, svg_el)
    return {}
  }

  function on_svg_down(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    edges: WfEdge[],
    dist_to_edge_fn: (px: number, py: number, edge: WfEdge) => number,
  ): { sel_nodes?: Set<string>; sel_edge?: string | null } {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panning = true
      pan_start = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      return {}
    }
    const pt = get_svg_pt(e, svg_el)
    let clicked_edge: string | null = null
    let min_d = 12
    for (const edge of edges) {
      const d = dist_to_edge_fn(pt.x, pt.y, edge)
      if (d < min_d) { min_d = d; clicked_edge = edge.id }
    }
    if (clicked_edge) {
      return { sel_edge: clicked_edge, sel_nodes: new Set() }
    }
    const target = e.target as Element
    if (target === svg_el || target.hasAttribute(`data-bg`) || target.closest(`[data-bg]`)) {
      if (e.shiftKey) {
        box_sel = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
      } else {
        panning = true
        pan_start = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      }
      return { sel_nodes: new Set(), sel_edge: null }
    }
    return {}
  }

  function on_svg_move(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    nodes: WfNode[],
    sel_nodes: Set<string>,
  ): { nodes?: WfNode[] } {
    if (panning) {
      pan = { x: e.clientX - pan_start.x, y: e.clientY - pan_start.y }
      return {}
    }
    const pt = get_svg_pt(e, svg_el)
    if (box_sel) {
      box_sel = { ...box_sel, x2: pt.x, y2: pt.y }
      return {}
    }
    if (drag) {
      const moving = sel_nodes.has(drag.id) ? sel_nodes : new Set([drag.id])
      const new_nodes = nodes.map(n => {
        if (!moving.has(n.id)) return n
        const orig = drag!.start.find(sn => sn.id === n.id)
        const main_orig = drag!.start.find(sn => sn.id === drag!.id)
        if (!orig || !main_orig) return n
        const dx = pt.x - drag!.ox - main_orig.x
        const dy = pt.y - drag!.oy - main_orig.y
        return { ...n, x: snap(orig.x + dx), y: snap(orig.y + dy) }
      })
      return { nodes: new_nodes }
    }
    if (conn) mouse = pt
    return {}
  }

  function on_svg_up(
    e: MouseEvent,
    svg_el: SVGSVGElement | null,
    nodes: WfNode[],
    edges: WfEdge[],
    would_create_cycle: (from_id: string, to_id: string) => boolean,
    on_cycle_warning: (msg: string) => void,
  ) {
    if (panning) {
      panning = false
      return { should_push_history: false }
    }
    if (box_sel) {
      const x1 = Math.min(box_sel.x1, box_sel.x2)
      const x2 = Math.max(box_sel.x1, box_sel.x2)
      const y1 = Math.min(box_sel.y1, box_sel.y2)
      const y2 = Math.max(box_sel.y1, box_sel.y2)
      const selected = nodes.filter(n => n.x >= x1 && n.x + NW <= x2 && n.y >= y1 && n.y + get_nh(n) <= y2).map(n => n.id)
      box_sel = null
      return { sel_nodes: new Set(selected), should_push_history: false }
    }
    if (conn) {
      const pt = get_svg_pt(e, svg_el)
      let best_node: WfNode | null = null
      let best_handle: string | null = null
      let best_d = 20
      for (const n of nodes) {
        if (n.id === conn.from_id) continue
        const cfg = NODE_DEFINITIONS[n.type]
        const inputs = cfg?.inputs || []
        for (let i = 0; i < Math.max(inputs.length, 1); i++) {
          const hid = `in-${i}`
          const hp = get_handle_pos(n, hid, true)
          const d = Math.sqrt((pt.x - hp.x) ** 2 + (pt.y - hp.y) ** 2)
          if (d < best_d) { best_d = d; best_node = n; best_handle = hid }
        }
      }
      let new_edges: WfEdge[] | undefined
      if (best_node && best_handle) {
        const dup = edges.find(ed => ed.from === conn!.from_id && ed.to === best_node!.id && ed.fromH === conn!.from_h && ed.toH === best_handle)
        if (!dup) {
          if (would_create_cycle(conn.from_id, best_node.id)) {
            on_cycle_warning(`Cannot connect: this would create a cycle in the workflow graph.`)
          } else {
            new_edges = [...edges, { id: `e${Date.now()}`, from: conn.from_id, to: best_node.id, fromH: conn.from_h, toH: best_handle }]
          }
        }
      }
      conn = null
      return { edges: new_edges, should_push_history: !!new_edges }
    }
    if (drag) {
      const d_node = nodes.find(n => n.id === drag!.id)
      const moved = d_node && drag!.start ? (() => {
        const orig = (drag!.start as typeof nodes).find((n: typeof nodes[0]) => n.id === drag!.id)
        return orig && (Math.abs(d_node.x - orig.x) > 2 || Math.abs(d_node.y - orig.y) > 2)
      })() : false
      const result: {
        should_push_history: boolean
        click_node_id?: string
        click_node?: WfNode
      } = { should_push_history: !!moved }
      if (!moved && d_node && d_node.type === `structure_input` && !d_node.params.structure_json) {
        result.click_node_id = drag.id
        result.click_node = d_node
      }
      drag = null
      return result
    }
    return { should_push_history: false }
  }

  function handle_wheel(e: WheelEvent, svg_el: SVGSVGElement) {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.92 : 1.08
    const new_zoom = Math.max(0.2, Math.min(3, zoom * factor))
    const r = svg_el.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    pan = { x: mx - (mx - pan.x) * (new_zoom / zoom), y: my - (my - pan.y) * (new_zoom / zoom) }
    zoom = new_zoom
  }

  return {
    get drag() { return drag },
    get conn() { return conn },
    get mouse() { return mouse },
    get pan() { return pan },
    get zoom() { return zoom },
    get panning() { return panning },
    get box_sel() { return box_sel },

    set_pan(p) { pan = p },
    set_zoom(z) { zoom = z },
    set_conn(c) { conn = c },
    reset_view() { pan = { x: 0, y: 0 }; zoom = 1 },

    get_svg_pt,
    on_node_down,
    on_handle_down,
    on_svg_down,
    on_svg_move,
    on_svg_up,
    handle_wheel,
  }
}
