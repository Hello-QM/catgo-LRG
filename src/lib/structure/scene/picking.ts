/**
 * Pure picking and selection helper functions extracted from StructureScene.svelte.
 * No Svelte or Threlte imports — only data in, data out.
 */

import type { Site } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import * as measure from '$lib/structure/measure'
import type { RenderPacket } from './render-packet'

export type PacketBond = {
  graph_idx: number
  site_idx_1: number
  site_idx_2: number
  base_idx_1: number
  base_idx_2: number
  kind: number
  jimage: [number, number, number]
  pos_1: Vec3
  /** Endpoint B after applying the graph's periodic image offset. */
  pos_2: Vec3
}

/** Resolve one exact packet bond without consulting the legacy per-frame bond list. */
export function resolve_packet_bond(
  packet: RenderPacket | null,
  graph_idx: number,
): PacketBond | null {
  const graph = packet?.topology.bond_graph
  if (!packet || !graph || !Number.isInteger(graph_idx) || graph_idx < 0) return null
  const pair_offset = graph_idx * 2
  const image_offset = graph_idx * 3
  if (pair_offset + 1 >= graph.pairs.length || image_offset + 2 >= graph.jimages.length) {
    return null
  }

  const base_idx_1 = graph.pairs[pair_offset]
  const base_idx_2 = graph.pairs[pair_offset + 1]
  const n = packet.topology.atom_count
  if (base_idx_1 >= n || base_idx_2 >= n) return null
  const positions = packet.frame.positions
  if (positions.length < n * 3) return null

  const p1 = base_idx_1 * 3
  const p2 = base_idx_2 * 3
  const jx = graph.jimages[image_offset]
  const jy = graph.jimages[image_offset + 1]
  const jz = graph.jimages[image_offset + 2]
  const lattice = packet.frame.lattice
  const pos_1: Vec3 = [positions[p1], positions[p1 + 1], positions[p1 + 2]]
  const pos_2: Vec3 = [
    positions[p2] + jx * lattice[0] + jy * lattice[3] + jz * lattice[6],
    positions[p2 + 1] + jx * lattice[1] + jy * lattice[4] + jz * lattice[7],
    positions[p2 + 2] + jx * lattice[2] + jy * lattice[5] + jz * lattice[8],
  ]
  const site_ids = packet.topology.site_ids
  return {
    graph_idx,
    base_idx_1,
    base_idx_2,
    site_idx_1: site_ids[base_idx_1] ?? base_idx_1,
    site_idx_2: site_ids[base_idx_2] ?? base_idx_2,
    kind: graph.kinds[graph_idx] ?? 0,
    jimage: [jx, jy, jz],
    pos_1,
    pos_2,
  }
}

/**
 * Toggle a site index in the selected_sites array.
 * Returns the new selected_sites array, or null if the selection limit was reached.
 */
export function toggle_site_selection(
  site_index: number,
  selected_sites: number[],
): number[] | null {
  // Check selection limit
  if (
    !selected_sites.includes(site_index) &&
    selected_sites.length >= measure.MAX_SELECTED_SITES
  ) {
    return null // Limit reached
  }

  const was_selected = selected_sites.includes(site_index)
  return was_selected
    ? selected_sites.filter((idx) => idx !== site_index)
    : [...selected_sites, site_index]
}

/**
 * Clean measured_sites by removing indices that are out of bounds.
 * Returns the cleaned array.
 */
export function clean_measured_sites(
  measured_sites: number[],
  site_count: number,
): number[] {
  if (site_count <= 0) return []
  return measured_sites.filter((idx) => idx >= 0 && idx < site_count)
}

/**
 * Check if an atom is pickable (not hidden by cutting plane).
 */
export function is_atom_pickable(
  site_idx: number,
  cutting_active: boolean,
  cutting_visibility_map: Map<number, { inside: boolean; opacity: number; saturation: number }>,
): boolean {
  if (!cutting_active || cutting_visibility_map.size === 0) return true
  const vis = cutting_visibility_map.get(site_idx)
  if (!vis) return true
  return vis.inside
}

/**
 * Build highlight entries for selected and active sites.
 */
export function build_highlight_entries(
  selected_sites: number[],
  active_sites: number[],
  structure_sites: Site[] | undefined,
  pulse_opacity: number,
  selection_highlight_color: string,
  active_highlight_color: string,
): {
  kind: string
  site: Site | null
  site_idx: number
  opacity: number
  color: string
}[] {
  return [
    ...(selected_sites ?? []).map((idx) => ({
      kind: `selected`,
      site: structure_sites?.[idx] ?? null,
      site_idx: idx,
      opacity: pulse_opacity,
      color: selection_highlight_color,
    })),
    ...(active_sites ?? []).map((idx) => ({
      kind: `active`,
      site: structure_sites?.[idx] ?? null,
      site_idx: idx,
      opacity: pulse_opacity,
      color: active_highlight_color,
    })),
  ]
}
