/**
 * Pure graph model types, constants, geometry helpers, validation, layout,
 * copy/paste helpers, serialization, node classification, and templates.
 *
 * Extracted from WorkflowEditor.svelte — no reactive ($state) references.
 */

import { NODE_DEFINITIONS } from './node-definitions'

// ─── Types ───
export interface WfNode {
  id: string
  type: string
  x: number
  y: number
  params: Record<string, unknown>
}

export interface WfEdge {
  id: string
  from: string
  to: string
  fromH: string
  toH: string
  label?: string
}

// ─── Constants ───
export const NW = 260
export const NH = 72
export const GRID = 20
export const HANDLE_R = 7
export const MM_W = 180
export const MM_H = 110

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID
}

// Monotonic counter: guarantees unique ids even within the same millisecond.
// (Math.random alone collided ~0.3% per 100 calls and intermittently flaked the
// uniqueness test in CI.)
let _id_seq = 0
export function uid(): string {
  return `n${Date.now().toString(36)}-${(_id_seq++).toString(36)}`
}

// ─── Param display helpers ───
const HIDDEN_PARAM_KEYS = new Set([
  `structure_json`, `trajectory_json`, `custom_incar_text`, `custom_kpoints_text`,
  `hpc_session_id`, `job_script`, `vasp_executable`,
  `job_nodes`, `job_ntasks`, `job_cpus_per_task`, `job_walltime`, `job_partition`, `job_name`, `job_memory`,
  `potcar_root`, `potcar_functional`, `job_script_id`, `sort_structure`,
  `calculator_method`, `electronic_temperature`, `accuracy`, `delta`, `gamma`,
  `label`, `formula`, `n_atoms`, `n_frames`,
  // Adsorbate-related params (should not display on structure_input nodes)
  `species`, `mode`, `height`, `site_id`, `_species_idx`, `_custom_species`,
  `frame_selection`,
])

export function get_display_params(params: Record<string, unknown> | undefined): [string, unknown][] {
  if (!params) return []
  return Object.entries(params)
    .filter(([k, v]) => !HIDDEN_PARAM_KEYS.has(k) && String(v).length <= 80)
    .slice(0, 3)
}

// ─── Geometry helpers ───
export function get_nh(node: WfNode): number {
  const cfg = NODE_DEFINITIONS[node.type]
  if (!cfg) return NH
  const pc = get_display_params(node.params).length
  if (cfg.is_condition) return 95
  if (cfg.is_loop || cfg.is_merge) return 80
  return pc > 0 ? NH + Math.min(pc, 3) * 14 + 4 : NH
}

export function get_handle_pos(node: WfNode, hid: string, is_input: boolean): { x: number; y: number } {
  const cfg = NODE_DEFINITIONS[node.type]
  const handles = is_input ? (cfg?.inputs || []) : (cfg?.outputs || [])
  const idx = parseInt(hid.split(`-`)[1]) || 0
  const total = Math.max(handles.length, 1)
  const nh = get_nh(node)
  const spacing = nh / (total + 1)
  return is_input
    ? { x: node.x, y: node.y + spacing * (idx + 1) }
    : { x: node.x + NW, y: node.y + spacing * (idx + 1) }
}

export function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const cp = Math.max(Math.abs(x2 - x1) * 0.5, 60)
  return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`
}

export function point_on_bezier(x1: number, y1: number, x2: number, y2: number, t: number): { x: number; y: number } {
  const cp = Math.max(Math.abs(x2 - x1) * 0.5, 60)
  const cx1 = x1 + cp, cx2 = x2 - cp, u = 1 - t
  return {
    x: u*u*u*x1 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x2,
    y: u*u*u*y1 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y2,
  }
}

export function dist_to_edge(px: number, py: number, edge: WfEdge, nodes: WfNode[]): number {
  const fn = nodes.find(n => n.id === edge.from)
  const tn = nodes.find(n => n.id === edge.to)
  if (!fn || !tn) return Infinity
  const fp = get_handle_pos(fn, edge.fromH, false)
  const tp = get_handle_pos(tn, edge.toH, true)
  let minD = Infinity
  for (let t = 0; t <= 1; t += 0.02) {
    const p = point_on_bezier(fp.x, fp.y, tp.x, tp.y, t)
    const d = Math.sqrt((px - p.x) ** 2 + (py - p.y) ** 2)
    if (d < minD) minD = d
  }
  return minD
}

// ─── DAG validation (cycle detection) ───
export function has_cycle(nodes: WfNode[], test_edges: WfEdge[]): boolean {
  const adj: Record<string, string[]> = {}
  const in_deg: Record<string, number> = {}
  nodes.forEach(n => { adj[n.id] = []; in_deg[n.id] = 0 })
  test_edges.forEach(e => {
    if (adj[e.from]) adj[e.from].push(e.to)
    in_deg[e.to] = (in_deg[e.to] || 0) + 1
  })
  let queue = nodes.filter(n => in_deg[n.id] === 0).map(n => n.id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const nb of (adj[id] || [])) {
      in_deg[nb]--
      if (in_deg[nb] === 0) queue.push(nb)
    }
  }
  return visited < nodes.length
}

export function would_create_cycle(nodes: WfNode[], edges: WfEdge[], from_id: string, to_id: string): boolean {
  const test = [...edges, { id: `test`, from: from_id, to: to_id, fromH: ``, toH: `` }]
  return has_cycle(nodes, test)
}

// ─── Auto layout (Sugiyama-like) ───
export function auto_layout(nodes: WfNode[], edges: WfEdge[]): WfNode[] {
  const adj: Record<string, string[]> = {}
  const in_deg: Record<string, number> = {}
  nodes.forEach(n => { adj[n.id] = []; in_deg[n.id] = 0 })
  edges.forEach(e => { adj[e.from]?.push(e.to); in_deg[e.to] = (in_deg[e.to] || 0) + 1 })
  const layers: string[][] = []
  const assigned = new Set<string>()
  let queue = nodes.filter(n => in_deg[n.id] === 0).map(n => n.id)
  if (queue.length === 0 && nodes.length > 0) queue = [nodes[0].id]
  while (queue.length > 0) {
    layers.push([...queue])
    queue.forEach(id => assigned.add(id))
    const next: string[] = []
    queue.forEach(id => {
      (adj[id] || []).forEach(nb => {
        in_deg[nb]--
        if (in_deg[nb] <= 0 && !assigned.has(nb)) { next.push(nb); assigned.add(nb) }
      })
    })
    queue = next
  }
  nodes.filter(n => !assigned.has(n.id)).forEach(n => layers.push([n.id]))
  const pos: Record<string, { x: number; y: number }> = {}
  const gapX = 300, gapY = 140
  layers.forEach((ids, li) => {
    const totalH = ids.length * gapY
    ids.forEach((id, ni) => { pos[id] = { x: 80 + li * gapX, y: 60 + ni * gapY - totalH / 2 + 200 } })
  })
  return nodes.map(n => ({ ...n, x: pos[n.id]?.x ?? n.x, y: pos[n.id]?.y ?? n.y }))
}

// ─── Copy / Paste helpers ───
export function clone_for_paste(
  clipboard: { nodes: WfNode[]; edges: WfEdge[] },
): { nodes: WfNode[]; edges: WfEdge[] } {
  const id_map: Record<string, string> = {}
  const new_nodes = clipboard.nodes.map(n => {
    const new_id = uid()
    id_map[n.id] = new_id
    return { ...n, id: new_id, x: n.x + 40, y: n.y + 40 }
  })
  const new_edges = clipboard.edges.map(e => ({
    ...e, id: `e${Date.now().toString(36)}-${(_id_seq++).toString(36)}`,
    from: id_map[e.from], to: id_map[e.to],
  }))
  return { nodes: new_nodes, edges: new_edges }
}

// ─── Serialization ───
export function to_workflow_json(nodes: WfNode[], edges: WfEdge[]) {
  return {
    nodes: nodes.map(n => ({ id: n.id, type: n.type, params: n.params })),
    edges: edges.map(e => ({
      from: e.from, to: e.to, fromHandle: e.fromH, toHandle: e.toH,
      ...(e.label ? { label: e.label } : {}),
    })),
  }
}

// ─── Node classification ───
const VASP_NODE_TYPES = new Set([`vasp_relax`, `vasp_static`, `vasp_md`, `bulk_opt`, `slab_relax`, `frequency`, `electronic`])
const MLP_NODE_TYPES = new Set([`mlp_relax`, `mlp_md`])
const UNIFIED_CALC_TYPES = new Set([`geo_opt`, `single_point`, `cell_opt`, `md`, `md_minimize`, `freq`, `ts_search`, `irc`, `uvvis`])
const ORCA_NODE_TYPES = new Set([`orca_opt`, `orca_sp`, `orca_freq`, `orca_neb_ts`, `orca_irc`, `orca_uvvis`])
const CP2K_NODE_TYPES = new Set([`cp2k_geopt`, `cp2k_static`, `cp2k_cellopt`, `cp2k_md`, `cp2k_freq`])
const LAMMPS_NODE_TYPES = new Set([`lammps_md`, `polymer_md`])
const POLYMER_SIM_NODE_TYPES = new Set([`polymer_deform`, `glass_transition`])
const XTB_NODE_TYPES = new Set([`xtb_relax`, `xtb_static`])
const SELLA_NODE_TYPES = new Set([`sella_ts`])
const GAUSSIAN_NODE_TYPES = new Set([`gaussian_opt`, `gaussian_sp`, `gaussian_freq`])
const GROMACS_NODE_TYPES = new Set([`gromacs_md`])
const QE_NODE_TYPES = new Set([`qe_scf`, `qe_relax`, `qe_bands`, `qe_dos`, `qe_phonon`])
const QCHEM_NODE_TYPES = new Set([`qchem_static`, `qchem_opt`, `qchem_ts`])

const HPC_NODE_TYPES = new Set([
  ...VASP_NODE_TYPES, ...MLP_NODE_TYPES, ...UNIFIED_CALC_TYPES,
  ...ORCA_NODE_TYPES, ...CP2K_NODE_TYPES, ...XTB_NODE_TYPES,
  ...SELLA_NODE_TYPES, ...GAUSSIAN_NODE_TYPES, ...GROMACS_NODE_TYPES,
  ...QE_NODE_TYPES, ...QCHEM_NODE_TYPES,
  ...LAMMPS_NODE_TYPES, ...POLYMER_SIM_NODE_TYPES,
])

export function is_vasp_node(node_type: string, params?: Record<string, unknown>): boolean {
  if (VASP_NODE_TYPES.has(node_type)) return true
  if (UNIFIED_CALC_TYPES.has(node_type)) return params?.software === `vasp`
  return false
}

export function is_orca_node(node_type: string, params?: Record<string, unknown>): boolean {
  if (ORCA_NODE_TYPES.has(node_type)) return true
  if (UNIFIED_CALC_TYPES.has(node_type)) return params?.software === `orca`
  return false
}

export function is_cp2k_node(node_type: string, params?: Record<string, unknown>): boolean {
  if (CP2K_NODE_TYPES.has(node_type)) return true
  if (UNIFIED_CALC_TYPES.has(node_type)) return params?.software === `cp2k`
  return false
}

export function is_lammps_node(node_type: string, params?: Record<string, unknown>): boolean {
  if (LAMMPS_NODE_TYPES.has(node_type)) return true
  if (UNIFIED_CALC_TYPES.has(node_type)) return params?.software === `lammps`
  return false
}

export function is_hpc_node(node_type: string): boolean {
  return HPC_NODE_TYPES.has(node_type)
}

/** Node types that can run locally (MLP, LAMMPS, polymer sim).
 *  When execution_mode is "local", these don't need an HPC session. */
export const LOCAL_CAPABLE_NODE_TYPES = new Set([
  ...MLP_NODE_TYPES, ...LAMMPS_NODE_TYPES, ...POLYMER_SIM_NODE_TYPES,
])

/** Check if a node needs an HPC session based on its type.
 *  Does NOT check execution_mode — that's a global setting handled by the caller. */
export function node_needs_hpc(node_type: string, _params?: Record<string, unknown>): boolean {
  return HPC_NODE_TYPES.has(node_type) || UNIFIED_CALC_TYPES.has(node_type)
}

export function is_structure_node(node_type: string): boolean {
  return ['structure_input', 'slab_gen', 'adsorbate_place'].includes(node_type)
}

export function has_structure_io(node_type: string): boolean {
  const def = NODE_DEFINITIONS[node_type]
  if (!def) return false
  return def.inputs.includes(`structure`) || def.outputs.includes(`structure`)
}

/** VASP executable options */
export const VASP_EXECUTABLES = [`vasp_std`, `vasp_gam`, `vasp_ncl`]

/** Map workflow node params to VASP calculation type */
export function get_vasp_calc_type(node_type: string): string {
  const map: Record<string, string> = {
    // Legacy types
    vasp_relax: `opt`, vasp_static: `scf`, vasp_md: `opt`, bulk_opt: `opt`,
    slab_relax: `opt`, frequency: `freq`, electronic: `dos`,
    // Unified types
    geo_opt: `opt`, single_point: `scf`, cell_opt: `opt`,
    md: `opt`, freq: `freq`, ts_search: `opt`, irc: `opt`,
  }
  return map[node_type] || `scf`
}

/** Parse kpoints string like "4x4x4" to [[4,4,4]] */
export function parse_kpoints_str(kp: unknown): number[][] | undefined {
  if (!kp) return undefined
  const s = String(kp).replace(/[×x,]/g, ` `).trim().split(/\s+/).map(Number)
  if (s.length === 3 && s.every(n => n > 0 && Number.isFinite(n))) return [s]
  return undefined
}

/**
 * Node types that TRANSFORM their input structure into a meaningfully
 * different output (slab from bulk, slab+adsorbate from slab, doped slab,
 * etc.). For these, the BFS upstream resolver MUST stop at the node itself
 * — falling through to its parent gives the wrong structure (e.g. raw bulk
 * IrO2 where the caller wanted the slab). Pure pass-through / logic types
 * (loop, merge, condition) are NOT in this set, so they're still
 * transparently skipped while the transformation cache is being filled.
 */
const STRUCTURE_TRANSFORMING_TYPES = new Set<string>([
  `slab_gen`,
  `batch_slab_gen`,
  `batch_coverage_gen`,
  `adsorbate_place`,
  `batch_adsorbate_place`,
  `doping_gen`,
  `polymer_build`,
  `polymer_crosslink`,
])

/** BFS upstream to find the nearest ancestor node with structure_json.
 *
 * When the immediate parent is a STRUCTURE_TRANSFORMING_TYPES node whose
 * own `structure_json` hasn't been cached yet (preview not finished,
 * step not run, etc.), this returns `null` instead of falling through to
 * its grandparent. Falling through there silently substitutes the bulk
 * crystal for the expected slab — that's the "sometimes slab / sometimes
 * bulk" race CatBot-built OER pipelines were hitting.
 */
export function resolve_input_structure(node_id: string, nodes: WfNode[], edges: WfEdge[]): string | null {
  const visited = new Set<string>()
  const queue = [node_id]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const edge of edges) {
      if (edge.to !== current) continue
      const parent = nodes.find(n => n.id === edge.from)
      if (!parent || visited.has(parent.id)) continue
      if (parent.params?.structure_json) return parent.params.structure_json as string
      if (STRUCTURE_TRANSFORMING_TYPES.has(parent.type)) {
        // Don't fall through past a transformer that hasn't produced its
        // output yet — wait for it. The caller will retry once
        // SlabGenPreview / AdsorbatePlacePanel writes structure_json back
        // (Svelte reactivity re-runs the derived).
        return null
      }
      queue.push(parent.id)
    }
  }
  return null
}

/**
 * Resolve upstream structures as an array. Returns string[] when upstream
 * node has multiple structures (e.g. doping_gen with _fan_out), or wraps
 * a single structure in an array for uniform handling.
 */
export function resolve_input_structures(
  node_id: string,
  nodes: WfNode[],
  edges: WfEdge[],
): string[] | null {
  const visited = new Set<string>()
  const queue = [node_id]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const edge of edges) {
      if (edge.to !== current) continue
      const parent = nodes.find(n => n.id === edge.from)
      if (!parent || visited.has(parent.id)) continue
      const p = parent.params
      if (p) {
        // structures_json: may be array or JSON string of array
        const sj = p.structures_json
        if (sj) {
          const arr = Array.isArray(sj) ? sj : (() => { try { return JSON.parse(sj as string) } catch { return null } })()
          if (Array.isArray(arr) && arr.length > 0) return arr as string[]
        }
        // generated_structures_json: same — may be JSON string of array
        const gj = p.generated_structures_json
        if (gj) {
          const arr = Array.isArray(gj) ? gj : (() => { try { return JSON.parse(gj as string) } catch { return null } })()
          if (Array.isArray(arr) && arr.length > 0) return arr as string[]
        }
        if (p.structure_json)
          return [p.structure_json as string]
      }
      // Same wait-don't-fall-through rule as resolve_input_structure: a
      // transformer parent without cached output blocks the BFS instead
      // of letting us silently grab the grandparent's bulk crystal.
      if (STRUCTURE_TRANSFORMING_TYPES.has(parent.type)) return null
      queue.push(parent.id)
    }
  }
  return null
}

// ─── Templates ───
export const TEMPLATES: Record<string, { name: string; desc: string; nodes: WfNode[]; edges: WfEdge[] }> = {
  band_structure: {
    name: `Band Structure`, desc: `Relax \u2192 Static \u2192 Band`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `geo_opt`, x: 360, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t3`, type: `single_point`, x: 660, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11 } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  adsorption_screening: {
    name: `Adsorption Screening`, desc: `Parallel DFT & MLP, then compare`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 200, params: {} },
      { id: `t2`, type: `geo_opt`, x: 360, y: 100, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, kpoints: `3\u00D73\u00D71` } },
      { id: `t3`, type: `geo_opt`, x: 360, y: 320, params: { software: `mlp`, model: `MACE`, fmax: 0.01 } },
      { id: `t4`, type: `condition`, x: 680, y: 200, params: { field: `energy_diff`, op: `<`, value: `0.05` } },
      { id: `t5`, type: `single_point`, x: 1000, y: 100, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11 } },
      { id: `t6`, type: `analysis`, x: 1000, y: 340, params: { type: `re-optimize` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t1`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t2`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-1` },
      { id: `te5`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0`, label: `\u2713 converged` },
      { id: `te6`, from: `t4`, to: `t6`, fromH: `out-1`, toH: `in-0`, label: `\u2717 retry` },
    ],
  },
  mlp_md_pipeline: {
    name: `MLP MD Pipeline`, desc: `Structure \u2192 MLP MD \u2192 Analysis \u2192 Export`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `md`, x: 360, y: 160, params: { software: `mlp`, model: `MACE`, temp: 300, steps: 10000 } },
      { id: `t3`, type: `analysis`, x: 660, y: 160, params: { type: `trajectory_analysis` } },
      { id: `t4`, type: `export_data`, x: 960, y: 160, params: { format: `json`, db: `ase.db` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  batch_surface: {
    name: `Batch Surface Calc`, desc: `Loop surfaces \u2192 Relax \u2192 Merge \u2192 Analyze`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `loop`, x: 340, y: 180, params: { variable: `surface`, max_iter: 20 } },
      { id: `t3`, type: `geo_opt`, x: 620, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, kpoints: `3\u00D73\u00D71` } },
      { id: `t4`, type: `merge`, x: 900, y: 180, params: {} },
      { id: `t5`, type: `analysis`, x: 1180, y: 180, params: { type: `surface_energy` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t2`, to: `t4`, fromH: `out-1`, toH: `in-1` },
      { id: `te5`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  // ─── VASP Workflows ───
  vasp_double_relax: {
    name: `VASP Double Relax`, desc: `Input \u2192 Relax (coarse) \u2192 Relax (fine) \u2192 Static`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `geo_opt`, x: 340, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-4`, ISIF: 3, NSW: 100, kpoints: `4\u00D74\u00D74` } },
      { id: `t3`, type: `geo_opt`, x: 620, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t4`, type: `single_point`, x: 900, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11 } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  vasp_mp_metagga: {
    name: `MP r\u00B2SCAN Relaxation`, desc: `PBEsol pre-relax \u2192 r\u00B2SCAN double relax \u2192 Static`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `geo_opt`, x: 320, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-4`, ISIF: 3, NSW: 100, PREC: `Accurate`, kpoints: `4\u00D74\u00D74` } },
      { id: `t3`, type: `geo_opt`, x: 580, y: 160, params: { software: `vasp`, ENCUT: 680, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t4`, type: `geo_opt`, x: 840, y: 160, params: { software: `vasp`, ENCUT: 680, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t5`, type: `single_point`, x: 1100, y: 160, params: { software: `vasp`, ENCUT: 680, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11, kpoints: `4\u00D74\u00D74` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  vasp_electronic: {
    name: `Electronic Structure`, desc: `Relax \u2192 Electronic \u2192 DOS + Charge analysis`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 200, params: {} },
      { id: `t2`, type: `geo_opt`, x: 340, y: 200, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t3`, type: `electronic`, x: 620, y: 200, params: { ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, NEDOS: 3001, kpoints: `6\u00D76\u00D76` } },
      { id: `t4`, type: `dos_analysis`, x: 920, y: 120, params: {} },
      { id: `t5`, type: `charge_analysis`, x: 920, y: 300, params: {} },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t3`, to: `t5`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  // ─── CP2K Workflows ───
  cp2k_opt_static: {
    name: `CP2K Optimize + Static`, desc: `CellOpt \u2192 Static \u2192 Export`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `cell_opt`, x: 340, y: 160, params: { software: `cp2k`, functional: `PBE`, basis_set: `DZVP-MOLOPT-SR-GTH`, cutoff: 600, vdw: `D3` } },
      { id: `t3`, type: `single_point`, x: 620, y: 160, params: { software: `cp2k`, functional: `PBE`, basis_set: `DZVP-MOLOPT-SR-GTH`, cutoff: 600, vdw: `D3` } },
      { id: `t4`, type: `export_data`, x: 900, y: 160, params: { format: `json` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  cp2k_vibrational: {
    name: `CP2K Vibrational`, desc: `GeoOpt \u2192 Frequency \u2192 Analysis`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `geo_opt`, x: 340, y: 160, params: { software: `cp2k`, functional: `PBE`, basis_set: `DZVP-MOLOPT-SR-GTH`, cutoff: 600, vdw: `D3` } },
      { id: `t3`, type: `freq`, x: 620, y: 160, params: { software: `cp2k`, functional: `PBE`, cutoff: 600 } },
      { id: `t4`, type: `analysis`, x: 900, y: 160, params: { type: `phonon` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  // ─── Surface Catalysis Workflows ───
  bulk_to_slabs: {
    name: `Bulk to Slabs`, desc: `CellOpt \u2192 SlabGen \u2192 Loop \u2192 Relax \u2192 Static \u2192 Merge \u2192 Analyze`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `cell_opt`, x: 300, y: 180, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `6\u00D76\u00D76` } },
      { id: `t3`, type: `slab_gen`, x: 540, y: 180, params: { miller: `1,0,0`, layers: 4, vacuum: 15 } },
      { id: `t4`, type: `loop`, x: 780, y: 180, params: { variable: `slab`, max_iter: 10 } },
      { id: `t5`, type: `geo_opt`, x: 1020, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, LDIPOL: true, frozen_layers: 2, kpoints: `3\u00D73\u00D71` } },
      { id: `t6`, type: `single_point`, x: 1260, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, kpoints: `3\u00D73\u00D71` } },
      { id: `t7`, type: `merge`, x: 1500, y: 180, params: {} },
      { id: `t8`, type: `analysis`, x: 1740, y: 180, params: { type: `surface_energy` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
      { id: `te6`, from: `t6`, to: `t7`, fromH: `out-0`, toH: `in-0` },
      { id: `te7`, from: `t4`, to: `t7`, fromH: `out-1`, toH: `in-1` },
      { id: `te8`, from: `t7`, to: `t8`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  slab_to_adsorbates: {
    name: `Slab to Adsorbates`, desc: `Adsorbate \u2192 Loop \u2192 Relax \u2192 Static \u2192 Merge \u2192 Compare`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `adsorbate_place`, x: 320, y: 180, params: { adsorbate: `OH` } },
      { id: `t3`, type: `loop`, x: 560, y: 180, params: { variable: `site`, max_iter: 20 } },
      { id: `t4`, type: `geo_opt`, x: 800, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, LDIPOL: true, frozen_layers: 2, kpoints: `3\u00D73\u00D71` } },
      { id: `t5`, type: `single_point`, x: 1040, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, kpoints: `3\u00D73\u00D71` } },
      { id: `t6`, type: `merge`, x: 1280, y: 180, params: {} },
      { id: `t7`, type: `energy_compare`, x: 1520, y: 180, params: {} },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
      { id: `te6`, from: `t3`, to: `t6`, fromH: `out-1`, toH: `in-1` },
      { id: `te7`, from: `t6`, to: `t7`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  full_catalysis: {
    name: `Full Catalysis Pipeline`, desc: `Bulk \u2192 Slab \u2192 Adsorbate \u2192 Relax \u2192 Freq \u2192 Free Energy`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `cell_opt`, x: 280, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `6\u00D76\u00D76` } },
      { id: `t3`, type: `slab_gen`, x: 500, y: 160, params: { miller: `1,1,1`, layers: 4, vacuum: 15 } },
      { id: `t4`, type: `geo_opt`, x: 720, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, LDIPOL: true, frozen_layers: 2, kpoints: `3\u00D73\u00D71` } },
      { id: `t5`, type: `adsorbate_place`, x: 940, y: 160, params: { adsorbate: `N2` } },
      { id: `t6`, type: `geo_opt`, x: 1160, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, LDIPOL: true, frozen_layers: 2, kpoints: `3\u00D73\u00D71` } },
      { id: `t7`, type: `freq`, x: 1380, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, IBRION: 5, NFREE: 2, freeze_mode: `adsorbate`, kpoints: `3\u00D73\u00D71` } },
      { id: `t8`, type: `free_energy`, x: 1600, y: 160, params: { temperature: 298.15 } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
      { id: `te6`, from: `t6`, to: `t7`, fromH: `out-0`, toH: `in-0` },
      { id: `te7`, from: `t7`, to: `t8`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  // ─── Multi-fidelity & Advanced Workflows ───
  mlp_pre_dft: {
    name: `MLP Pre-screen + DFT`, desc: `MLP Relax \u2192 Convergence \u2192 VASP Relax \u2192 Static \u2192 Export`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 160, params: {} },
      { id: `t2`, type: `geo_opt`, x: 320, y: 160, params: { software: `mlp`, model: `MACE`, fmax: 0.02 } },
      { id: `t3`, type: `convergence_check`, x: 580, y: 160, params: { check_type: `energy`, threshold: 1e-3 } },
      { id: `t4`, type: `geo_opt`, x: 840, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `4\u00D74\u00D74` } },
      { id: `t5`, type: `single_point`, x: 1100, y: 160, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11, kpoints: `4\u00D74\u00D74` } },
      { id: `t6`, type: `export_data`, x: 1360, y: 160, params: { format: `json` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  elastic_tensor: {
    name: `Elastic Tensor`, desc: `Relax \u2192 Loop deformed \u2192 Relax \u2192 Merge \u2192 Analyze \u2192 Export`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `geo_opt`, x: 300, y: 180, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3, NSW: 200, kpoints: `6\u00D76\u00D76` } },
      { id: `t3`, type: `loop`, x: 540, y: 180, params: { variable: `deformation`, max_iter: 24 } },
      { id: `t4`, type: `geo_opt`, x: 780, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 100, kpoints: `6\u00D76\u00D76` } },
      { id: `t5`, type: `merge`, x: 1020, y: 180, params: {} },
      { id: `t6`, type: `analysis`, x: 1260, y: 180, params: { type: `elastic` } },
      { id: `t7`, type: `export_data`, x: 1500, y: 180, params: { format: `json` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t3`, to: `t5`, fromH: `out-1`, toH: `in-1` },
      { id: `te6`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
      { id: `te7`, from: `t6`, to: `t7`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  mlp_phonon: {
    name: `MLP Phonon`, desc: `MLP Relax \u2192 Loop supercells \u2192 xTB Static \u2192 Merge \u2192 Analyze`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `geo_opt`, x: 300, y: 180, params: { software: `mlp`, model: `MACE`, fmax: 0.01 } },
      { id: `t3`, type: `loop`, x: 540, y: 180, params: { variable: `supercell`, max_iter: 50 } },
      { id: `t4`, type: `single_point`, x: 780, y: 120, params: { software: `xtb`, method: `GFN2-xTB` } },
      { id: `t5`, type: `merge`, x: 1020, y: 180, params: {} },
      { id: `t6`, type: `analysis`, x: 1260, y: 180, params: { type: `phonon` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t3`, to: `t5`, fromH: `out-1`, toH: `in-1` },
      { id: `te6`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  ts_search: {
    name: `Transition State Search`, desc: `xTB Sella \u2192 Freq \u2192 Condition \u2192 VASP Sella \u2192 Freq`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 200, params: {} },
      { id: `t2`, type: `ts_search`, x: 320, y: 200, params: { software: `sella`, calculator: `xtb`, calculator_method: `GFN2-xTB`, fmax: 0.01, order: 1 } },
      { id: `t3`, type: `freq`, x: 580, y: 200, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, IBRION: 5, NFREE: 2 } },
      { id: `t4`, type: `condition`, x: 840, y: 200, params: { field: `imaginary_freq`, op: `>`, value: `0` } },
      { id: `t5`, type: `ts_search`, x: 1120, y: 120, params: { software: `sella`, calculator: `vasp`, ENCUT: 520, EDIFF: `1e-5`, fmax: 0.01, order: 1 } },
      { id: `t6`, type: `freq`, x: 1400, y: 120, params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, IBRION: 5, NFREE: 2 } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
      { id: `te5`, from: `t5`, to: `t6`, fromH: `out-0`, toH: `in-0` },
    ],
  },

  // ─── Doped Catalyst Screening ───
  doped_catalyst_screening: {
    name: `Doped Catalyst Screening`,
    desc: `Structure → Slab → Doping (enumerate) → Relax → Compare`,
    nodes: [
      { id: `t1`, type: `structure_input`, x: 60, y: 180, params: {} },
      { id: `t2`, type: `slab_gen`, x: 300, y: 180, params: { miller: `1,1,0`, layers: 4, vacuum: 15 } },
      { id: `t3`, type: `doping_gen`, x: 540, y: 180, params: { dopant: `Fe`, target_element: ``, count: 1, enumerate: true, max_configs: 20, deduplicate: true } },
      { id: `t4`, type: `geo_opt`, x: 780, y: 180, params: { software: `mlp`, model: `MACE`, system_type: `periodic`, fmax: 0.03 } },
      { id: `t5`, type: `energy_compare`, x: 1020, y: 180, params: {} },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
      { id: `te4`, from: `t4`, to: `t5`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  // ─── Electrochemical Workflows ───
  electrochemical_slow_growth: {
    name: `Electrochemical Slow-Growth`, desc: `Structure \u2192 Opt \u2192 CP-MD Equil \u2192 CP-Slow-Growth \u2192 Trajectory Analysis + Barrier Analysis`,
    nodes: [
      // 1. Structure input (slab + water + adsorbates, pre-built)
      { id: `t1`, type: `structure_input`, x: 60, y: 240, params: {} },
      // 2. Geometry optimization (static relaxation)
      { id: `t2`, type: `geo_opt`, x: 340, y: 240, params: {
        software: `vasp`, ENCUT: 400, EDIFF: `1e-5`, ISIF: 2, NSW: 300, ISMEAR: 0, ISPIN: 1, PREC: `Accurate`,
        LDIPOL: true, frozen_layers: 2, kpoints: `2\u00D72\u00D71`,
      }},
      // 3. Constant-potential MD equilibration
      { id: `t3`, type: `md`, x: 620, y: 240, params: {
        software: `vasp`, TEBEG: 300, NSW: 5000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 4. Constant-potential slow-growth AIMD (reaction barrier)
      { id: `t4`, type: `slow_growth`, x: 920, y: 240, params: {
        software: `vasp`, TEBEG: 300, NSW: 10000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        lblueout: true, increm: `-0.005`, iconst_content: ``,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 5. MD trajectory analysis (equilibration trajectory: RMSD, RDF, etc.)
      { id: `t5`, type: `md_analysis`, x: 820, y: 420, params: { analyses: `rmsd,rdf` } },
      // 6. Barrier analysis (slow-growth REPORT: free energy profile)
      { id: `t6`, type: `md_analysis`, x: 1220, y: 240, params: { analyses: `slow_growth_report` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0`, label: `equilibrated` },
      { id: `te4`, from: `t3`, to: `t5`, fromH: `out-0`, toH: `in-0`, label: `trajectory` },
      { id: `te5`, from: `t4`, to: `t6`, fromH: `out-0`, toH: `in-0`, label: `REPORT` },
    ],
  },
  cn_coupling_barrier: {
    name: `C-N Coupling Barrier`, desc: `Structure \u2192 Opt \u2192 CP-MD Equil \u2192 Forward + Reverse Slow-Growth \u2192 Barrier Comparison`,
    nodes: [
      // 1. Structure input (Cu slab + water + C/N adsorbates)
      { id: `t1`, type: `structure_input`, x: 60, y: 260, params: {} },
      // 2. Geometry optimization
      { id: `t2`, type: `geo_opt`, x: 320, y: 260, params: {
        software: `vasp`, ENCUT: 400, EDIFF: `1e-5`, ISIF: 2, NSW: 300, ISMEAR: 0, ISPIN: 1, PREC: `Accurate`,
        LDIPOL: true, frozen_layers: 2, kpoints: `2\u00D72\u00D71`,
      }},
      // 3. Constant-potential MD equilibration
      { id: `t3`, type: `md`, x: 560, y: 260, params: {
        software: `vasp`, TEBEG: 300, NSW: 5000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 4a. Forward slow-growth (C-N bond formation: decrease distance)
      { id: `t4`, type: `slow_growth`, x: 840, y: 140, params: {
        software: `vasp`, TEBEG: 300, NSW: 8000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        lblueout: true, increm: `-0.005`, iconst_content: ``,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 4b. Reverse slow-growth (C-N bond breaking: increase distance)
      { id: `t5`, type: `slow_growth`, x: 840, y: 380, params: {
        software: `vasp`, TEBEG: 300, NSW: 8000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        lblueout: true, increm: `0.005`, iconst_content: ``,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 5. MD trajectory analysis (equilibration)
      { id: `t6`, type: `md_analysis`, x: 760, y: 480, params: { analyses: `rmsd,rdf` } },
      // 6. Barrier comparison (forward + reverse → hysteresis check)
      { id: `t7`, type: `md_analysis`, x: 1140, y: 260, params: { analyses: `barrier_comparison` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0`, label: `forward` },
      { id: `te4`, from: `t3`, to: `t5`, fromH: `out-0`, toH: `in-0`, label: `reverse` },
      { id: `te5`, from: `t3`, to: `t6`, fromH: `out-0`, toH: `in-0`, label: `trajectory` },
      { id: `te6`, from: `t4`, to: `t7`, fromH: `out-0`, toH: `in-0` },
      { id: `te7`, from: `t5`, to: `t7`, fromH: `out-0`, toH: `in-1` },
    ],
  },
  uma_catalysis_screening: {
    name: `UMA Catalysis Tutorial`, desc: `Full Ni catalyst pipeline: Bulk \u2192 Slabs \u2192 Surface Energy \u2192 Wulff \u2192 H Adsorption + ZPE \u2192 Coverage Sweep \u2192 NEB Barrier`,
    nodes: [
      // ═══ Part 1: Bulk optimization ═══
      { id: `u1`, type: `structure_input`, x: 60, y: 300, params: { label: `Ni bulk (FCC)` } },
      { id: `u2`, type: `geo_opt`, x: 320, y: 300, params: { software: `mlp`, model: `MACE`, relax_cell: true, fmax: 0.05, max_steps: 500, mlp_optimizer: `LBFGS` } },

      // ═══ Part 2: Batch slab generation (4 facets × 3 thicknesses) ═══
      { id: `u3`, type: `batch_slab_gen`, x: 600, y: 160, params: {
        vacuum: 15, center_slab: true,
        combinations: `[[1,1,1,4],[1,1,1,6],[1,1,1,8],[1,0,0,4],[1,0,0,6],[1,0,0,8],[1,1,0,4],[1,1,0,6],[1,1,0,8],[2,1,1,4],[2,1,1,6],[2,1,1,8]]`,
      }},
      { id: `u4`, type: `geo_opt`, x: 900, y: 160, params: { software: `mlp`, model: `MACE`, fmax: 0.05, max_steps: 500, mlp_optimizer: `LBFGS` } },
      // Part 2: Surface energy analysis
      { id: `u5`, type: `surface_energy`, x: 1200, y: 160, params: { grouping: `auto` } },

      // ═══ Part 3: Wulff construction ═══
      { id: `u6`, type: `wulff_construction`, x: 1500, y: 160, params: {} },

      // ═══ Part 4: H adsorption + ZPE ═══
      // Slab + H relaxation
      { id: `u7`, type: `adsorbate_place`, x: 600, y: 460, params: { species: `*H`, site: `fcc` } },
      { id: `u8`, type: `geo_opt`, x: 900, y: 460, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // Clean slab relaxation
      { id: `u9`, type: `slab_gen`, x: 600, y: 620, params: { miller: `1,1,1`, layers: 4, vacuum: 15 } },
      { id: `u10`, type: `geo_opt`, x: 900, y: 620, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // H₂ reference molecule
      { id: `u11`, type: `structure_input`, x: 600, y: 780, params: { label: `H\u2082 molecule` } },
      { id: `u12`, type: `geo_opt`, x: 900, y: 780, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // Frequency calculations for ZPE.
      // freeze_invert must be FALSE: the engine's `frozen` set here is the
      // bottom N layers (layer-sorted by Z). `freeze_invert: true` would
      // vibrate THOSE atoms (substrate) and freeze everything else —
      // inverting the standard "freeze bottom, vibrate top + adsorbate"
      // convention and producing meaningless ZPE.
      { id: `u13`, type: `freq`, x: 1200, y: 460, params: { software: `mlp`, model: `MACE`, delta: 0.02, nfree: 2, freeze_mode: `layers`, freeze_layers: 2, freeze_invert: false } },
      { id: `u14`, type: `freq`, x: 1200, y: 780, params: { software: `mlp`, model: `MACE`, delta: 0.02, nfree: 2 } },
      // Adsorption energy with ZPE
      { id: `u15`, type: `adsorption_energy`, x: 1500, y: 620, params: { reference_coefficient: 0.5, include_zpe: true } },

      // ═══ Part 5: Coverage sweep ═══
      // Generate Ni(111) 4×4 slab from bulk opt
      { id: `u16`, type: `slab_gen`, x: 600, y: 980, params: { miller: `1,1,1`, layers: 4, vacuum: 15, supercell_a: 4, supercell_b: 4 } },
      { id: `u17`, type: `geo_opt`, x: 900, y: 920, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // Batch coverage: place 1,2,4,8,16 H atoms on the 4×4 slab
      { id: `u18`, type: `batch_coverage_gen`, x: 900, y: 1100, params: { species: `H`, coverages: `[1, 2, 4, 8, 16]`, site: `hollow`, n_surface_sites: 16, height: 1.0 } },
      { id: `u19`, type: `geo_opt`, x: 1200, y: 1100, params: { software: `mlp`, model: `MACE`, fmax: 0.05, max_steps: 500, mlp_optimizer: `BFGS` } },
      // Coverage analysis: E_ads vs theta
      { id: `u20`, type: `coverage_analysis`, x: 1500, y: 980, params: { reference_coefficient: 0.5, species: `H`, n_surface_sites: 16 } },

      // ═══ Part 6: CO dissociation NEB barrier (CO* → C* + O*) ═══
      // Reactant: CO* on Ni(111) — the LOWER-energy starting state for
      // Kreitz 2021's forward dissociation barrier.
      { id: `u21`, type: `structure_input`, x: 600, y: 1340, params: { label: `CO* on Ni(111)` } },
      { id: `u22`, type: `geo_opt`, x: 900, y: 1340, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // Product: C* + O* on Ni(111) — the higher-energy dissociated state.
      { id: `u23`, type: `structure_input`, x: 600, y: 1500, params: { label: `C* + O* on Ni(111)` } },
      { id: `u24`, type: `geo_opt`, x: 900, y: 1500, params: { software: `mlp`, model: `MACE`, fmax: 0.01, max_steps: 500, mlp_optimizer: `BFGS` } },
      // NEB transition state search. initial_step_id / final_step_id pin
      // the reaction direction explicitly — without them the engine would
      // fall back to SQLite edge-iteration order (not guaranteed stable)
      // and could silently compute the reverse barrier. See F4 fix in
      // server/workflow/engines/mlp.py NEB branch.
      { id: `u25`, type: `ts_search`, x: 1200, y: 1420, params: { software: `mlp`, model: `MACE`, nimages: 8, fmax: 0.05, max_steps: 500, climb: true, mlp_optimizer: `FIRE`, initial_step_id: `u22`, final_step_id: `u24` } },
      // Freq on TS for verification. Same freeze_invert rationale as u13 —
      // we want the substrate frozen and the adsorbate (C + O at the TS)
      // to vibrate so the imaginary mode corresponds to the reaction
      // coordinate, not a substrate rattling mode.
      { id: `u26`, type: `freq`, x: 1500, y: 1420, params: { software: `mlp`, model: `MACE`, delta: 0.02, nfree: 2, freeze_mode: `layers`, freeze_layers: 2, freeze_invert: false } },
    ],
    edges: [
      // Part 1 → Part 2: Bulk opt → batch slab gen
      { id: `ue1`, from: `u1`, to: `u2`, fromH: `out-0`, toH: `in-0` },
      { id: `ue2`, from: `u2`, to: `u3`, fromH: `out-0`, toH: `in-0` },
      // Part 2: Batch slabs → relax → surface energy
      { id: `ue3`, from: `u3`, to: `u4`, fromH: `out-0`, toH: `in-0` },
      { id: `ue4`, from: `u4`, to: `u5`, fromH: `out-1`, toH: `in-0` },
      // Part 2 → Part 3: Surface energy → Wulff
      { id: `ue5`, from: `u5`, to: `u6`, fromH: `out-0`, toH: `in-0` },
      // Part 4: H adsorption pathway
      { id: `ue6`, from: `u9`, to: `u7`, fromH: `out-0`, toH: `in-0` },
      { id: `ue7`, from: `u7`, to: `u8`, fromH: `out-0`, toH: `in-0` },
      // Clean slab from bulk opt
      { id: `ue8`, from: `u2`, to: `u9`, fromH: `out-0`, toH: `in-0` },
      { id: `ue9`, from: `u9`, to: `u10`, fromH: `out-0`, toH: `in-0` },
      // H₂ reference
      { id: `ue10`, from: `u11`, to: `u12`, fromH: `out-0`, toH: `in-0` },
      // Freq calculations
      { id: `ue11`, from: `u8`, to: `u13`, fromH: `out-0`, toH: `in-0` },
      { id: `ue12`, from: `u12`, to: `u14`, fromH: `out-0`, toH: `in-0` },
      // Adsorption energy: connect slab+H, clean slab, H₂ ref, freqs
      { id: `ue13`, from: `u8`, to: `u15`, fromH: `out-1`, toH: `in-0` },
      { id: `ue14`, from: `u10`, to: `u15`, fromH: `out-1`, toH: `in-0` },
      { id: `ue15`, from: `u12`, to: `u15`, fromH: `out-1`, toH: `in-0` },
      { id: `ue16`, from: `u13`, to: `u15`, fromH: `out-0`, toH: `in-0` },
      { id: `ue17`, from: `u14`, to: `u15`, fromH: `out-0`, toH: `in-0` },
      // Part 5: Coverage sweep
      { id: `ue18`, from: `u2`, to: `u16`, fromH: `out-0`, toH: `in-0` },
      { id: `ue19`, from: `u16`, to: `u17`, fromH: `out-0`, toH: `in-0` },
      { id: `ue20`, from: `u16`, to: `u18`, fromH: `out-0`, toH: `in-0` },
      { id: `ue21`, from: `u18`, to: `u19`, fromH: `out-0`, toH: `in-0` },
      // Coverage analysis: clean slab energy + coverage energies + H₂ ref
      { id: `ue22`, from: `u17`, to: `u20`, fromH: `out-1`, toH: `in-0` },
      { id: `ue23`, from: `u19`, to: `u20`, fromH: `out-1`, toH: `in-0` },
      { id: `ue24`, from: `u12`, to: `u20`, fromH: `out-1`, toH: `in-0` },
      // Part 6: NEB barrier
      { id: `ue25`, from: `u21`, to: `u22`, fromH: `out-0`, toH: `in-0` },
      { id: `ue26`, from: `u23`, to: `u24`, fromH: `out-0`, toH: `in-0` },
      // Relaxed reactant + product → NEB
      { id: `ue27`, from: `u22`, to: `u25`, fromH: `out-0`, toH: `in-0` },
      { id: `ue28`, from: `u24`, to: `u25`, fromH: `out-0`, toH: `in-1` },
      // NEB → Freq on TS
      { id: `ue29`, from: `u25`, to: `u26`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  constant_potential_aimd: {
    name: `Constant-Potential AIMD`, desc: `Structure \u2192 Opt \u2192 CP-MD Equilibration \u2192 Trajectory Analysis`,
    nodes: [
      // 1. Structure input
      { id: `t1`, type: `structure_input`, x: 60, y: 200, params: {} },
      // 2. Geometry optimization
      { id: `t2`, type: `geo_opt`, x: 340, y: 200, params: {
        software: `vasp`, ENCUT: 400, EDIFF: `1e-5`, ISIF: 2, NSW: 200, ISMEAR: 0, ISPIN: 1, PREC: `Accurate`,
        LDIPOL: true, frozen_layers: 2, kpoints: `2\u00D72\u00D71`,
      }},
      // 3. Constant-potential MD (production run)
      { id: `t3`, type: `md`, x: 640, y: 200, params: {
        software: `vasp`, TEBEG: 300, NSW: 10000, POTIM: 1.0, SMASS: 0,
        ENCUT: 400, EDIFF: `1e-4`, ISMEAR: 0, ISPIN: 1, kpoints: `1\u00D71\u00D71`,
        constant_potential: `cpvasp`, cpvasp_targetmu: -4.6, cpvasp_nescheme: 5,
        LDIPOL: true, frozen_layers: 2,
      }},
      // 4. MD trajectory analysis
      { id: `t4`, type: `md_analysis`, x: 940, y: 200, params: { analyses: `rmsd,rdf` } },
    ],
    edges: [
      { id: `te1`, from: `t1`, to: `t2`, fromH: `out-0`, toH: `in-0` },
      { id: `te2`, from: `t2`, to: `t3`, fromH: `out-0`, toH: `in-0` },
      { id: `te3`, from: `t3`, to: `t4`, fromH: `out-0`, toH: `in-0` },
    ],
  },
  coverage_sweep: {
    name: `Coverage Sweep`, desc: `Slab \u2192 H Coverage Sweep \u2192 E_ads vs \u03B8`,
    nodes: [
      { id: `c1`, type: `structure_input`, x: 60, y: 200, params: {} },
      { id: `c2`, type: `geo_opt`, x: 300, y: 200, params: { software: `mlp`, model: `MACE`, relax_cell: true, fmax: 0.05, mlp_optimizer: `LBFGS` } },
      { id: `c3`, type: `slab_gen`, x: 540, y: 200, params: { miller: `1,1,1`, layers: 4, vacuum: 15, supercell: `4\u00D74` } },
      { id: `c4`, type: `geo_opt`, x: 780, y: 100, params: { software: `mlp`, model: `MACE`, fmax: 0.01, mlp_optimizer: `BFGS` } },
      { id: `c5`, type: `batch_coverage_gen`, x: 780, y: 320, params: { species: `H`, coverages: `[1, 2, 4, 8, 16]`, site: `hollow`, n_surface_sites: 16, height: 1.0 } },
      { id: `c6`, type: `geo_opt`, x: 1020, y: 320, params: { software: `mlp`, model: `MACE`, fmax: 0.05, mlp_optimizer: `BFGS` } },
      { id: `c7`, type: `structure_input`, x: 60, y: 440, params: { label: `H\u2082 molecule` } },
      { id: `c8`, type: `geo_opt`, x: 300, y: 440, params: { software: `mlp`, model: `MACE`, fmax: 0.01, mlp_optimizer: `BFGS` } },
      { id: `c9`, type: `coverage_analysis`, x: 1260, y: 240, params: { reference_coefficient: 0.5 } },
    ],
    edges: [
      { id: `ce1`, from: `c1`, to: `c2`, fromH: `out-0`, toH: `in-0` },
      { id: `ce2`, from: `c2`, to: `c3`, fromH: `out-0`, toH: `in-0` },
      { id: `ce3`, from: `c3`, to: `c4`, fromH: `out-0`, toH: `in-0` },
      { id: `ce4`, from: `c3`, to: `c5`, fromH: `out-0`, toH: `in-0` },
      { id: `ce5`, from: `c5`, to: `c6`, fromH: `out-0`, toH: `in-0` },
      { id: `ce6`, from: `c4`, to: `c9`, fromH: `out-1`, toH: `in-0` },
      { id: `ce7`, from: `c6`, to: `c9`, fromH: `out-1`, toH: `in-0` },
      { id: `ce8`, from: `c8`, to: `c9`, fromH: `out-1`, toH: `in-0` },
      { id: `ce9`, from: `c7`, to: `c8`, fromH: `out-0`, toH: `in-0` },
    ],
  },
}

export const TEMPLATE_GROUPS: { label: string; keys: string[] }[] = [
  { label: `General`, keys: [`band_structure`, `adsorption_screening`, `mlp_md_pipeline`, `batch_surface`] },
  { label: `VASP`, keys: [`vasp_double_relax`, `vasp_mp_metagga`, `vasp_electronic`] },
  { label: `CP2K`, keys: [`cp2k_opt_static`, `cp2k_vibrational`] },
  { label: `Surface Catalysis`, keys: [`uma_catalysis_screening`, `bulk_to_slabs`, `slab_to_adsorbates`, `full_catalysis`, `doped_catalyst_screening`, `coverage_sweep`] },
  { label: `Electrochemistry`, keys: [`electrochemical_slow_growth`, `cn_coupling_barrier`, `constant_potential_aimd`] },
  { label: `Multi-fidelity & Advanced`, keys: [`mlp_pre_dft`, `elastic_tensor`, `mlp_phonon`, `ts_search`] },
]

/** Parse slab_gen node params into typed values */
export function parse_slab_gen_params(params: Record<string, unknown>): {
  miller: [number, number, number]
  layers: number
  vacuum: number
  supercell: [number, number]
  termination: number
} {
  // Miller indices: "1,1,0" → [1,1,0]
  let miller: [number, number, number] = [1, 1, 1]
  const m = String(params.miller ?? `1,1,1`).replace(/\s/g, ``).split(`,`).map(Number)
  if (m.length >= 3 && m.every(n => Number.isFinite(n))) miller = [m[0], m[1], m[2]]

  const layers = Math.max(1, Number(params.layers) || 4)
  const vacuum = Math.max(0, Number(params.vacuum) || 15)
  const termination = Math.max(0, Number(params.termination) || 0)

  // Supercell: prefer separate supercell_a / supercell_b params (node definition),
  // fall back to combined "2×2" string format for legacy/MCP compatibility.
  let supercell: [number, number] = [1, 1]
  if (params.supercell_a != null || params.supercell_b != null) {
    const a = Math.max(1, Number(params.supercell_a) || 1)
    const b = Math.max(1, Number(params.supercell_b) || 1)
    supercell = [a, b]
  } else {
    const sc_str = String(params.supercell ?? `1×1`).replace(/\s/g, ``)
    const sc_parts = sc_str.split(/[×xX]/).map(Number)
    if (sc_parts.length >= 2 && sc_parts.every(n => n > 0 && Number.isFinite(n))) {
      supercell = [sc_parts[0], sc_parts[1]]
    } else if (sc_parts.length === 1 && sc_parts[0] > 0 && Number.isFinite(sc_parts[0])) {
      supercell = [sc_parts[0], sc_parts[0]]
    }
  }

  return { miller, layers, vacuum, supercell, termination }
}
