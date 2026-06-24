import type { NodeDefinition, SidebarCategory } from '../workflow-types'

// Re-export common shared items
export { SOFTWARE_PERIODICITY } from './common'

// Import node groups
import { CALCULATION_NODES } from './calculation/index'
import { UTILITY_NODES } from './utility/index'
import { SPECIALIZED_NODES } from './specialized/index'
import { LOGIC_NODES } from './logic/index'
import { ANALYSIS_NODES } from './analysis/index'


// ====================================================================
//  NODE DEFINITIONS — assembled from category modules
// ====================================================================

export const NODE_DEFINITIONS: Record<string, NodeDefinition> = {
  ...UTILITY_NODES,
  ...CALCULATION_NODES,
  ...SPECIALIZED_NODES,
  ...LOGIC_NODES,
  ...ANALYSIS_NODES,
}


// ====================================================================
//  NODE TYPE MIGRATION MAP — old type → { type, defaults }
// ====================================================================

export const NODE_TYPE_MIGRATION: Record<string, { type: string; defaults: Record<string, unknown> }> = {
  vasp_relax:   { type: `geo_opt`,      defaults: { software: `vasp` } },
  cp2k_geopt:   { type: `geo_opt`,      defaults: { software: `cp2k` } },
  orca_opt:     { type: `geo_opt`,      defaults: { software: `orca` } },
  xtb_relax:    { type: `geo_opt`,      defaults: { software: `xtb` } },
  mlp_relax:    { type: `geo_opt`,      defaults: { software: `mlp` } },
  bulk_opt:     { type: `cell_opt`,     defaults: { software: `vasp` } },
  slab_relax:   { type: `geo_opt`,      defaults: { software: `vasp`, ISIF: 2, LDIPOL: true } },

  vasp_static:  { type: `single_point`, defaults: { software: `vasp` } },
  cp2k_static:  { type: `single_point`, defaults: { software: `cp2k` } },
  orca_sp:      { type: `single_point`, defaults: { software: `orca` } },
  xtb_static:   { type: `single_point`, defaults: { software: `xtb` } },

  cp2k_cellopt: { type: `cell_opt`,     defaults: { software: `cp2k` } },

  vasp_md:      { type: `md`,           defaults: { software: `vasp` } },
  cp2k_md:      { type: `md`,           defaults: { software: `cp2k` } },
  lammps_md:    { type: `md`,           defaults: { software: `lammps` } },
  gromacs_md:   { type: `md`,           defaults: { software: `gromacs` } },
  amber_md:     { type: `md`,           defaults: { software: `amber` } },
  mlp_md:       { type: `md`,           defaults: { software: `mlp` } },

  amber_minimize: { type: `geo_opt`,   defaults: { software: `amber` } },

  frequency:    { type: `freq`,         defaults: { software: `vasp` } },
  cp2k_freq:    { type: `freq`,         defaults: { software: `cp2k` } },
  orca_freq:    { type: `freq`,         defaults: { software: `orca` } },

  sella_ts:     { type: `ts_search`,    defaults: { software: `sella` } },
  orca_neb_ts:  { type: `ts_search`,    defaults: { software: `orca` } },
  // Backend recipes / engine emit a raw `neb` node; the frontend models NEB as
  // the TS Search calc node (software=MLP NEB / ORCA NEB-TS), so migrate it so
  // those workflows render instead of showing edges into an unrendered node.
  neb:          { type: `ts_search`,    defaults: { software: `mlp` } },

  orca_irc:     { type: `irc`,          defaults: { software: `orca` } },
}


// ====================================================================
//  SIDEBAR & CATEGORY FUNCTIONS
// ====================================================================

/** The unified calc types that are merged into a single "Calculation" palette entry */
export const UNIFIED_CALC_TYPES = new Set([`geo_opt`, `single_point`, `cell_opt`, `md`, `md_minimize`, `freq`, `ts_search`, `irc`, `slow_growth`, `kmc`])

/** Ordered list of calc types for the Calculation Type dropdown */
export const CALC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `geo_opt`, label: `Geometry Optimization` },
  { value: `single_point`, label: `Single Point` },
  { value: `cell_opt`, label: `Cell Optimization` },
  { value: `md`, label: `Molecular Dynamics` },
  { value: `md_minimize`, label: `MD Minimize` },
  { value: `freq`, label: `Frequency Analysis` },
  { value: `ts_search`, label: `Transition State Search` },
  { value: `irc`, label: `IRC` },
  { value: `slow_growth`, label: `Slow-Growth AIMD` },
  { value: `kmc`, label: `KMC / Microkinetic` },
]

/** Tool types shown as individual sidebar items (not merged into "Tools" palette) */
export const STANDALONE_TOOL_TYPES = new Set([`slab_gen`, `doping_gen`, `adsorbate_place`, `batch_slab_gen`])

/** The unified tool types that are merged into a single "Tools" palette entry */
export const UNIFIED_TOOL_TYPES = new Set([
  `slab_gen`, `doping_gen`, `adsorbate_place`, `batch_adsorbate_place`, `batch_slab_gen`,
  `polymer_build`, `polymer_crosslink`, `reference_mol`, `polymer_md`, `glass_transition`, `polymer_deform`,
])

/** Ordered list of tool types for the Tool Type dropdown */
export const TOOL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `slab_gen`, label: `Slab Gen` },
  { value: `doping_gen`, label: `Doping Gen` },
  { value: `adsorbate_place`, label: `Adsorbate` },
  { value: `batch_adsorbate_place`, label: `Batch Adsorbate` },
  { value: `batch_slab_gen`, label: `Batch Slab Gen` },
  { value: `polymer_build`, label: `Polymer Build` },
  { value: `polymer_crosslink`, label: `Crosslink` },
  { value: `reference_mol`, label: `Ref Molecule` },
  { value: `polymer_md`, label: `Polymer MD` },
  { value: `glass_transition`, label: `Tg Calculation` },
  { value: `polymer_deform`, label: `Polymer Deform` },
]

/** The unified analysis types that are merged into a single "Analysis" palette entry */
export const UNIFIED_ANALYSIS_TYPES = new Set([
  `dos_analysis`, `cohp_analysis`, `md_analysis`,
  `charge_analysis`, `electronic`, `free_energy`, `gibbs_energy`,
  `surface_energy`, `wulff_construction`, `adsorption_energy`,
])

/** Ordered list of analysis types for the Analysis Type dropdown */
export const ANALYSIS_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `dos_analysis`, label: `DOS Analysis` },
  { value: `cohp_analysis`, label: `COHP Analysis` },
  { value: `md_analysis`, label: `MD Analysis` },
  { value: `charge_analysis`, label: `Charge Analysis` },
  { value: `electronic`, label: `Electronic Structure` },
  { value: `free_energy`, label: `Free Energy Diagram` },
  { value: `gibbs_energy`, label: `Gibbs Energy` },
  { value: `surface_energy`, label: `Surface Energy` },
  { value: `wulff_construction`, label: `Wulff Construction` },
  { value: `adsorption_energy`, label: `Adsorption Energy` },
]

/** Node categories for the palette sidebar */
export function get_node_categories(): { id: string; label: string; nodes: NodeDefinition[] }[] {
  const cat_order = [`Input`, `Calculation`, `Tools`, `Logic`, `Analysis`]
  const cats: Record<string, NodeDefinition[]> = {}
  for (const def of Object.values(NODE_DEFINITIONS)) {
    if (!cats[def.category]) cats[def.category] = []
    cats[def.category].push(def)
  }
  return cat_order
    .filter((id) => cats[id])
    .map((id) => ({ id, label: id, nodes: cats[id] }))
}

/** 2-level sidebar hierarchy organized by task type */
export function get_sidebar_categories(): SidebarCategory[] {
  const all = Object.values(NODE_DEFINITIONS)
  const by_cat = (cat: string) => all.filter((d) => d.category === cat)

  // Merge all unified calc types into a single "Calculation" palette entry
  const calc_entry: NodeDefinition = {
    type: `geo_opt`,
    label: `Calculation`,
    color: `#3b82f6`,
    icon: `\u26A1`,
    category: `Calculation`,
    description: `DFT / ML / semi-empirical calculation`,
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: NODE_DEFINITIONS[`geo_opt`]?.default_params ?? {},
  }

  // Merge all tool types into a single "Tools" palette entry
  const tools_entry: NodeDefinition = {
    type: `slab_gen`,
    label: `Tools`,
    color: `#0e7490`,
    icon: `\u{1F6E0}\uFE0F`,
    category: `Tools`,
    description: `Structure manipulation & building tools`,
    inputs: [`structure`],
    outputs: [`structure`],
    default_params: NODE_DEFINITIONS[`slab_gen`]?.default_params ?? {},
  }

  // Merge all analysis types into a single "Analysis" palette entry
  const analysis_entry: NodeDefinition = {
    type: `dos_analysis`,
    label: `Analysis`,
    color: `#db2777`,
    icon: `\u{1F4CA}`,
    category: `Analysis`,
    description: `Post-processing & analysis`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: NODE_DEFINITIONS[`dos_analysis`]?.default_params ?? {},
  }

  // Pull out standalone tool nodes (slab_gen, doping_gen, adsorbate_place) as individual sidebar items
  const standalone_tools = [...STANDALONE_TOOL_TYPES]
    .map(t => NODE_DEFINITIONS[t])
    .filter(Boolean)

  const categories: SidebarCategory[] = [
    { id: `Input`, label: `Input`, icon: `\u{1F4C2}`, nodes: by_cat(`Input`) },
    { id: `Calculation`, label: `Calculation`, icon: `\u26A1`, nodes: [calc_entry] },
    { id: `Build`, label: `Build`, icon: `\u{1F9EA}`, nodes: standalone_tools },
    { id: `Tools`, label: `Tools`, icon: `\u{1F6E0}\uFE0F`, nodes: [tools_entry] },
    { id: `Logic`, label: `Logic`, icon: `\u25C7`, nodes: by_cat(`Logic`) },
    { id: `Analysis`, label: `Analysis`, icon: `\u{1F4CA}`, nodes: [analysis_entry] },
  ]

  // Add Plugin category if any plugin nodes exist
  const plugin_nodes = by_cat(`Plugin`)
  if (plugin_nodes.length > 0) {
    categories.push({ id: `Plugin`, label: `Plugin`, icon: `\u{1F9E9}`, nodes: plugin_nodes })
  }

  // Filter out empty categories
  return categories.filter((c) => (c.nodes && c.nodes.length > 0) || (c.subcategories && c.subcategories.length > 0))
}

/** Plugin node definitions fetched from backend */
let _plugin_nodes: Record<string, NodeDefinition> = {}

/**
 * Load plugin node definitions from the backend API.
 * Called on WorkflowEditor mount to merge plugin nodes into NODE_DEFINITIONS.
 * Fetches from both the legacy plugin endpoint and the new ToolRegistry endpoint.
 */
export async function load_plugin_nodes(api_base: string): Promise<void> {
  const _merge_nodes = (data: any) => {
    if (!data?.nodes || !Array.isArray(data.nodes)) return
    for (const def of data.nodes) {
      if (def.type && !NODE_DEFINITIONS[def.type]) {
        NODE_DEFINITIONS[def.type] = def as NodeDefinition
        _plugin_nodes[def.type] = def as NodeDefinition
      }
    }
  }

  // Fetch from both endpoints in parallel — either may be unavailable
  const [legacy, tools] = await Promise.allSettled([
    fetch(`${api_base}/plugins/workflow-nodes`).then(r => r.ok ? r.json() : null),
    fetch(`${api_base}/tools/workflow-nodes`).then(r => r.ok ? r.json() : null),
  ])

  if (legacy.status === `fulfilled` && legacy.value) _merge_nodes(legacy.value)
  if (tools.status === `fulfilled` && tools.value) _merge_nodes(tools.value)
}

/** Check if a node type is from a plugin */
export function is_plugin_node(type: string): boolean {
  return type in _plugin_nodes
}

export { load_dynamic_engines, get_engine_spec, all_engine_specs } from './dynamic'
