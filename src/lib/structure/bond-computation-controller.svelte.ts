// Bond computation controller extracted from StructureScene.svelte.
// Manages bond connectivity state, $effect.pre bond computation,
// hydrogen bond detection, and generation counters for async race handling.

import type { AnyStructure, BondPair, HBondConnectivity, Site, Vec3 } from '$lib'
import type { ShowBonds } from '$lib/settings'
import type { BondingStrategy } from './bonding'
import { compute_bond_transform, detect_hydrogen_bonds } from './bonding'
import { BOND_KIND, type BondManager } from './bonding/bond-manager.svelte'
import { compute_bonds_async, compute_bonds_sync, compute_hbonds_worker } from './workers/bond-worker-api'
import { should_show_bonds, filter_bonds_during_drag } from './scene'
import { get_element_fingerprint, get_position_hash } from './scene'
import * as math from '$lib/math'
import type { Crystal } from './index'

/**
 * Create bond computation reactive state.
 * Must be called from component `<script>` context (Svelte 5 $state).
 */
export function create_bond_state() {
  let bond_connectivity = $state<Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }>>([])
  let last_bond_structure = $state<AnyStructure | null>(null)
  let last_bond_strategy = $state(``)
  let last_bond_fingerprint = $state(``)
  let last_elem_fingerprint = $state(``)
  let bond_worker_pending = $state(false)
  // Generation counter MUST be plain `let`, NOT $state — $effect.pre tracks $state
  // reads and would re-run when the counter changes, causing infinite loops.
  let bond_computation_gen = 0

  return {
    get bond_connectivity() { return bond_connectivity },
    set bond_connectivity(v) { bond_connectivity = v },
    get last_bond_structure() { return last_bond_structure },
    set last_bond_structure(v) { last_bond_structure = v },
    get last_bond_strategy() { return last_bond_strategy },
    set last_bond_strategy(v) { last_bond_strategy = v },
    get last_bond_fingerprint() { return last_bond_fingerprint },
    set last_bond_fingerprint(v) { last_bond_fingerprint = v },
    get last_elem_fingerprint() { return last_elem_fingerprint },
    set last_elem_fingerprint(v) { last_elem_fingerprint = v },
    get bond_worker_pending() { return bond_worker_pending },
    set bond_worker_pending(v) { bond_worker_pending = v },
    get bond_computation_gen() { return bond_computation_gen },
    set bond_computation_gen(v) { bond_computation_gen = v },
  }
}

/**
 * Run the bond connectivity computation logic.
 * Called inside `$effect.pre` in the component.
 *
 * This updates bond_state in-place and dispatches async computation for large structures.
 */
export function compute_bond_connectivity(
  bond_state: ReturnType<typeof create_bond_state>,
  bond_pairs_setter: (pairs: BondPair[]) => void,
  structure: AnyStructure | undefined,
  show_bonds: ShowBonds,
  lattice: Crystal['lattice'] | null,
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
  external_dragging: boolean,
): void {
  if (!structure?.sites) {
    bond_state.bond_connectivity = []
    bond_pairs_setter([])
    bond_state.last_bond_fingerprint = ``
    bond_state.last_elem_fingerprint = ``
    bond_state.last_bond_strategy = ``
    return
  }

  const bonds_visible = should_show_bonds(show_bonds, lattice)

  if (!bonds_visible || (show_bonds as string) === `never`) {
    bond_state.bond_computation_gen++ // invalidate any in-flight async workers
    bond_state.bond_worker_pending = false
    bond_pairs_setter([])
    bond_state.bond_connectivity = []
    bond_state.last_bond_structure = null
    bond_state.last_bond_strategy = ``
    bond_state.last_bond_fingerprint = ``
    bond_state.last_elem_fingerprint = ``
    return
  }

  const sites = structure.sites
  const strategy_key = `${bonding_strategy}-${JSON.stringify(bonding_options)}`

  const strategy_changed = strategy_key !== bond_state.last_bond_strategy
  const elem_fp = get_element_fingerprint(sites)

  // Plan v3 Phase 6: trajectory fast-path block (the |TRAJ sentinel) deleted.
  // Trajectory playback bypasses this function entirely via the
  // build_bond_pairs trajectory branch (StructureScene.svelte) and the X2
  // early-return gate (Phase 5.5). This function now only runs for
  // non-trajectory operations: drag commits, topology changes, selection
  // updates.
  const fingerprint = `${elem_fp}|${get_position_hash(sites).toFixed(4)}`
  const structure_changed = fingerprint !== bond_state.last_bond_fingerprint

  if ((structure_changed || strategy_changed) && !external_dragging) {
    // Phase 5: bonds are computed on the pre-ghost structure (passed in as
    // `structure` here — caller is expected to have already stripped ghosts).
    // PBC stays enabled, so the WASM detector emits cross-cell bonds with
    // their `image` field set; the renderer paints two halves per bond,
    // anchored to the original atoms (not ghosts). The previous workaround
    // (strip lattice when ghosts are present) is gone.
    const bond_structure = structure

    // Synchronous path (small structures, <=200 atoms)
    const sync_bonds = compute_bonds_sync(
      bond_structure, bonding_strategy, bonding_options as Record<string, number>,
    )
    if (sync_bonds) {
      const lattice_pbc = (bond_structure as { lattice?: { pbc?: boolean[] } }).lattice?.pbc
      bond_state.bond_connectivity = sync_bonds.map(b => {
        const ji = (b.jimage ?? [0, 0, 0]) as [number, number, number]
        // Dev-only invariant: when an axis is non-periodic, jimage must be 0.
        if (import.meta.env.DEV && lattice_pbc) {
          for (let i = 0; i < 3; i++) {
            if (lattice_pbc[i] === false && ji[i] !== 0) {
              console.warn(
                `[bonds] jimage[${i}]=${ji[i]} on non-periodic axis (pbc=${JSON.stringify(lattice_pbc)})`,
                b,
              )
            }
          }
        }
        return {
          site_idx_1: b.site_idx_1,
          site_idx_2: b.site_idx_2,
          strength: b.strength,
          jimage: ji,
        }
      })
      bond_state.last_bond_structure = structure
      bond_state.last_bond_strategy = strategy_key
      bond_state.last_bond_fingerprint = fingerprint
      bond_state.last_elem_fingerprint = elem_fp
      return
    }

    // Async path (large structures, >1000 atoms).
    // Always clear old bonds — stale connectivity from a previous frame
    // produces elongated garbage bonds when atoms move to new positions.
    bond_state.bond_connectivity = []
    bond_state.last_bond_structure = null

    const captured_structure = bond_structure
    const captured_fingerprint = fingerprint
    const captured_elem_fp = elem_fp
    const captured_strategy_key = strategy_key
    const captured_strategy = bonding_strategy
    const captured_options = bonding_options

    bond_state.bond_worker_pending = true
    const gen = ++bond_state.bond_computation_gen
    const lattice_pbc_async = (captured_structure as { lattice?: { pbc?: boolean[] } }).lattice?.pbc
    compute_bonds_async(captured_structure, captured_strategy, captured_options as Record<string, number>)
      .then((new_bonds) => {
        if (gen !== bond_state.bond_computation_gen) {
          bond_state.bond_worker_pending = false
          return
        }
        bond_state.bond_connectivity = new_bonds.map(b => {
          const ji = (b.jimage ?? [0, 0, 0]) as [number, number, number]
          if (import.meta.env.DEV && lattice_pbc_async) {
            for (let i = 0; i < 3; i++) {
              if (lattice_pbc_async[i] === false && ji[i] !== 0) {
                console.warn(
                  `[bonds] jimage[${i}]=${ji[i]} on non-periodic axis (pbc=${JSON.stringify(lattice_pbc_async)})`,
                  b,
                )
              }
            }
          }
          return {
            site_idx_1: b.site_idx_1,
            site_idx_2: b.site_idx_2,
            strength: b.strength,
            jimage: ji,
          }
        })
        bond_state.last_bond_structure = captured_structure
        bond_state.last_bond_strategy = captured_strategy_key
        bond_state.last_bond_fingerprint = captured_fingerprint
        bond_state.last_elem_fingerprint = captured_elem_fp
        bond_state.bond_worker_pending = false
      })
      .catch((e) => {
        console.debug(`[StructureScene] Bond computation failed:`, e)
        if (gen === bond_state.bond_computation_gen) bond_state.bond_worker_pending = false
      })
  }
}

/**
 * Apply lattice·jimage offset to a base position (only if jimage != 0).
 * Lattice matrix rows are vectors a, b, c (pymatgen convention).
 */
function apply_jimage(
  base: Vec3,
  jimage: [number, number, number],
  lattice_matrix: number[][] | undefined,
): Vec3 {
  const [dx, dy, dz] = jimage
  if ((dx | dy | dz) === 0 || !lattice_matrix || lattice_matrix.length !== 3) return base
  const [ax, ay, az] = lattice_matrix[0] as Vec3
  const [bx, by, bz] = lattice_matrix[1] as Vec3
  const [cx, cy, cz] = lattice_matrix[2] as Vec3
  return [
    base[0] + dx * ax + dy * bx + dz * cx,
    base[1] + dx * ay + dy * by + dz * cy,
    base[2] + dx * az + dy * bz + dz * cz,
  ]
}

/**
 * Build bond_pairs from connectivity + current positions.
 * Called inside `$effect.pre` in the component.
 *
 * For cross-cell bonds (jimage != [0,0,0]), `transform_matrix` and
 * `bond_length` are computed against `b_eff = pos_2 + lattice·jimage`,
 * so downstream consumers (hitbox, hover-highlight, picker) align with
 * the actual half-bond geometry. `pos_2` itself is kept as the base
 * position per plan §2.1 to keep the drag-recompute dependency explicit.
 */
export function build_bond_pairs(
  bond_connectivity: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage?: [number, number, number] }>,
  last_bond_structure: AnyStructure | null,
  structure: AnyStructure | undefined,
  realtime_position_overrides: Map<number, Vec3> | null,
  external_dragging: boolean,
  selected_sites: number[],
): BondPair[] {
  const has_overrides = realtime_position_overrides && realtime_position_overrides.size > 0
  const bond_struct = (has_overrides ? last_bond_structure : last_bond_structure ?? structure) as typeof structure

  if (!bond_struct?.sites || bond_connectivity.length === 0) {
    return []
  }

  // During dragging: hide cross-bonds (one atom selected, one not)
  let bonds_to_render = bond_connectivity
  if (external_dragging && selected_sites.length > 0) {
    bonds_to_render = filter_bonds_during_drag(bond_connectivity, selected_sites)
  }

  const pos_struct = has_overrides ? bond_struct : (structure ?? bond_struct)
  const lattice_matrix = (bond_struct as { lattice?: { matrix?: number[][] } }).lattice?.matrix
  return bonds_to_render.map(conn => {
    const base_pos_1 = pos_struct.sites[conn.site_idx_1]?.xyz
    const base_pos_2 = pos_struct.sites[conn.site_idx_2]?.xyz
    if (!base_pos_1 || !base_pos_2) return null

    const pos_1 = realtime_position_overrides?.get(conn.site_idx_1) ?? base_pos_1
    const pos_2 = realtime_position_overrides?.get(conn.site_idx_2) ?? base_pos_2

    const jimage = conn.jimage ?? [0, 0, 0]
    const b_eff = apply_jimage(pos_2, jimage, lattice_matrix)
    const diff = math.subtract(b_eff, pos_1)
    const bond_length = Math.hypot(diff[0], diff[1], diff[2])
    const pair: BondPair = {
      pos_1,
      pos_2,
      site_idx_1: conn.site_idx_1,
      site_idx_2: conn.site_idx_2,
      bond_length,
      strength: conn.strength,
      transform_matrix: compute_bond_transform(pos_1, b_eff),
      jimage,
    }
    return pair
  }).filter((b): b is BondPair => b !== null)
}

/**
 * Build bond_pairs from trajectory frame positions (flat Float32Array).
 * Used for trajectory fast-path playback.
 *
 * Plan v3 Phase 3 — extended signature (Reviewer 1 H2 + W6 Open Q4):
 * - overrides: drag-precedence map; if a bond endpoint's site_idx is in
 *   the map, use the dragged position instead of the trajectory cache.
 * - atom_manager: fallback for site_idx values that exceed the trajectory
 *   cache coverage (supercell-extra atoms whose positions live in the
 *   manager but not in the per-frame Float32Array). Reads via
 *   atom_manager.find_slot_by_site_id + get_x/y/z.
 *
 * Endpoint-position priority chain per W4 §6 + plan v3:
 *   1. overrides?.get(site_idx)            — drag wins
 *   2. trajectory_frame_positions[site_idx*3..] if site_idx in range
 *   3. atom_manager slot lookup if site_idx out of trajectory range
 *   4. null endpoint → bond filtered out
 */
export function build_trajectory_bond_pairs(
  bond_connectivity: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage?: [number, number, number] }>,
  trajectory_frame_positions: Float32Array,
  overrides?: Map<number, Vec3> | null,
  atom_manager?: {
    count: number
    site_ids_buffer: Uint32Array
    find_slot_by_site_id: (sid: number) => number
    get_x: (slot: number) => number
    get_y: (slot: number) => number
    get_z: (slot: number) => number
  } | null,
  lattice_matrix?: number[][] | null,
): BondPair[] {
  const traj_max_site = Math.floor(trajectory_frame_positions.length / 3)
  function lookup_pos(site_idx: number): Vec3 | null {
    const overridden = overrides?.get(site_idx)
    if (overridden) return overridden
    if (site_idx < traj_max_site) {
      const i = site_idx * 3
      return [
        trajectory_frame_positions[i],
        trajectory_frame_positions[i + 1],
        trajectory_frame_positions[i + 2],
      ]
    }
    if (atom_manager) {
      const slot = atom_manager.find_slot_by_site_id(site_idx)
      if (slot >= 0) {
        return [
          atom_manager.get_x(slot),
          atom_manager.get_y(slot),
          atom_manager.get_z(slot),
        ]
      }
    }
    return null
  }
  const lat = lattice_matrix ?? undefined
  return bond_connectivity.map(conn => {
    const pos_1 = lookup_pos(conn.site_idx_1)
    const pos_2 = lookup_pos(conn.site_idx_2)
    if (pos_1 === null || pos_2 === null) return null
    const jimage = conn.jimage ?? [0, 0, 0]
    const b_eff = apply_jimage(pos_2, jimage, lat)
    const diff = math.subtract(b_eff, pos_1)
    const bond_length = Math.hypot(diff[0], diff[1], diff[2])
    const pair: BondPair = {
      pos_1,
      pos_2,
      site_idx_1: conn.site_idx_1,
      site_idx_2: conn.site_idx_2,
      bond_length,
      strength: conn.strength,
      transform_matrix: compute_bond_transform(pos_1, b_eff),
      jimage,
    }
    return pair
  }).filter((b): b is BondPair => b !== null)
}

/**
 * Create hydrogen bond reactive state.
 * Must be called from component `<script>` context.
 */
export function create_hbond_state() {
  let h_bond_connectivity = $state<HBondConnectivity[]>([])
  // Generation counter MUST be plain `let`, NOT $state
  let hbond_computation_gen = 0

  return {
    get h_bond_connectivity() { return h_bond_connectivity },
    set h_bond_connectivity(v) { h_bond_connectivity = v },
    get hbond_computation_gen() { return hbond_computation_gen },
    set hbond_computation_gen(v) { hbond_computation_gen = v },
  }
}

/**
 * Run hydrogen bond detection.
 * Called inside `$effect.pre` in the component.
 */
export function compute_hbond_connectivity(
  hbond_state: ReturnType<typeof create_hbond_state>,
  show_hydrogen_bonds: boolean,
  structure: AnyStructure | undefined,
  bond_pairs: BondPair[],
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
  hbond_distance_cutoff: number,
  hbond_angle_cutoff: number,
): void {
  if (!show_hydrogen_bonds || !structure?.sites) {
    hbond_state.hbond_computation_gen++ // invalidate any in-flight WASM call
    hbond_state.h_bond_connectivity = []
    return
  }

  const current_structure = structure
  // Use visible covalent bonds if available; otherwise compute them internally
  let current_bond_pairs = bond_pairs
  const hbond_options = {
    max_ha_distance: hbond_distance_cutoff,
    max_da_distance: hbond_distance_cutoff + 1.0,
    min_angle: hbond_angle_cutoff,
  }

  try {
    if (current_bond_pairs.length === 0) {
      const sync = compute_bonds_sync(current_structure, bonding_strategy, bonding_options as Record<string, number>)
      if (sync) {
        current_bond_pairs = sync
      } else {
        hbond_state.hbond_computation_gen++
        hbond_state.h_bond_connectivity = []
        return
      }
    }

    // JS computation first for immediate rendering (no flash)
    const js_hbonds = detect_hydrogen_bonds(current_structure, current_bond_pairs, hbond_options)
    // Extract topology from JS BondPair results.
    hbond_state.h_bond_connectivity = js_hbonds.map((b): HBondConnectivity => ({
      site_idx_1: b.site_idx_1,
      site_idx_2: b.site_idx_2,
      strength: b.strength,
      donor_idx: null,
      hydrogen_idx: b.site_idx_1,
      acceptor_idx: b.site_idx_2,
    }))
  } catch {
    hbond_state.h_bond_connectivity = []
    return
  }

  // Try WASM via Worker (off main thread) for better accuracy/performance
  const gen = ++hbond_state.hbond_computation_gen
  const captured_bonds = current_bond_pairs
  ;(async () => {
    try {
      const result = await compute_hbonds_worker(
        current_structure,
        captured_bonds,
        hbond_options as Record<string, number>,
      )
      if (gen !== hbond_state.hbond_computation_gen || !result) return
      const sites = current_structure.sites
      const connectivity: HBondConnectivity[] = []
      for (const hb of result) {
        const h_or_donor_idx = hb.h_idx ?? hb.donor_idx
        if (!sites[h_or_donor_idx]?.xyz || !sites[hb.acceptor_idx]?.xyz) continue
        connectivity.push({
          site_idx_1: h_or_donor_idx,
          site_idx_2: hb.acceptor_idx,
          strength: hb.strength,
          donor_idx: hb.donor_idx,
          hydrogen_idx: hb.h_idx ?? hb.donor_idx,
          acceptor_idx: hb.acceptor_idx,
        })
      }
      hbond_state.h_bond_connectivity = connectivity
    } catch { /* Worker/WASM unavailable, JS result already set */ }
  })()
}

/**
 * Build h_bond_pairs from connectivity + current positions.
 * Mirrors the regular bond_pairs pattern.
 */
export function build_hbond_pairs(
  h_bond_connectivity: HBondConnectivity[],
  last_bond_structure: AnyStructure | null,
  structure: AnyStructure | undefined,
  realtime_position_overrides: Map<number, Vec3> | null,
  external_dragging: boolean,
  selected_sites: number[],
): BondPair[] {
  try {
    if (h_bond_connectivity.length === 0) return []

    const has_overrides = realtime_position_overrides && realtime_position_overrides.size > 0
    const bond_struct = (has_overrides ? last_bond_structure : last_bond_structure ?? structure) as typeof structure
    if (!bond_struct?.sites) return []

    let conns_to_render = h_bond_connectivity
    if (external_dragging && selected_sites.length > 0) {
      const selected_set = new Set(selected_sites)
      conns_to_render = h_bond_connectivity.filter(conn => {
        const a_sel = selected_set.has(conn.site_idx_1)
        const b_sel = selected_set.has(conn.site_idx_2)
        return a_sel === b_sel
      })
    }

    const pos_struct = has_overrides ? bond_struct : (structure ?? bond_struct)
    return conns_to_render.map(conn => {
      const base_pos_1 = pos_struct.sites[conn.site_idx_1]?.xyz
      const base_pos_2 = pos_struct.sites[conn.site_idx_2]?.xyz
      if (!base_pos_1 || !base_pos_2) return null

      const pos_1 = realtime_position_overrides?.get(conn.site_idx_1) ?? base_pos_1
      const pos_2 = realtime_position_overrides?.get(conn.site_idx_2) ?? base_pos_2

      const bond_length = Math.hypot(pos_2[0] - pos_1[0], pos_2[1] - pos_1[1], pos_2[2] - pos_1[2])
      return {
        pos_1,
        pos_2,
        site_idx_1: conn.site_idx_1,
        site_idx_2: conn.site_idx_2,
        bond_length,
        strength: conn.strength,
        transform_matrix: compute_bond_transform(pos_1, pos_2),
        bond_type: `hydrogen` as const,
        jimage: [0, 0, 0] as [number, number, number],
      }
    }).filter(b => b !== null) as BondPair[]
  } catch {
    return []
  }
}

/**
 * Incremental atom-delete update for bond state.
 *
 * Applies a pure atom-delete to:
 *   - `bond_state.bond_connectivity` — filtered + reindexed in place
 *   - `bond_manager` — via `apply_atom_delete` (SoA compacting + reindex)
 *   - `bond_state.last_bond_fingerprint` / `last_elem_fingerprint` — bumped to
 *     the post-delete structure so `compute_bond_connectivity` treats the
 *     state as fresh and does NOT re-fire a full recompute on the next tick.
 *
 * Cost is O(bond_count + k log k), k = deleted_site_ids.size. No geometry
 * work, no WASM. Callers must pass the NEW `current_sites` (post-delete).
 *
 * Does not touch hydrogen-bond state — h-bonds fall back to full re-detection
 * on the next tick (known follow-up for X5/X6).
 */
export function apply_atom_delete_incremental(
  bond_state: ReturnType<typeof create_bond_state>,
  deleted_site_ids: readonly number[] | ReadonlySet<number>,
  bond_manager: BondManager | null,
  current_sites: Site[],
): void {
  const t0 = import.meta.env?.DEV ? performance.now() : 0

  // Normalize input.
  const deleted_set = new Set<number>()
  if (deleted_site_ids instanceof Set) {
    for (const v of deleted_site_ids) deleted_set.add(v >>> 0)
  } else {
    const arr = deleted_site_ids as readonly number[]
    for (let i = 0; i < arr.length; i++) deleted_set.add(arr[i] >>> 0)
  }

  if (deleted_set.size === 0) {
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[atoms-X4] apply_atom_delete_incremental: 0 atom(s), ${(performance.now() - t0).toFixed(2)}ms`)
    }
    return
  }

  const sorted_deleted: number[] = Array.from(deleted_set)
  sorted_deleted.sort((a, b) => a - b)

  // Binary search: count of entries strictly less than target.
  const count_less_than = (target: number): number => {
    let lo = 0
    let hi = sorted_deleted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted_deleted[mid] < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // Filter + reindex bond_connectivity.
  const prev = bond_state.bond_connectivity
  const next: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> = []
  for (let i = 0; i < prev.length; i++) {
    const c = prev[i]
    if (deleted_set.has(c.site_idx_1) || deleted_set.has(c.site_idx_2)) continue
    next.push({
      site_idx_1: c.site_idx_1 - count_less_than(c.site_idx_1),
      site_idx_2: c.site_idx_2 - count_less_than(c.site_idx_2),
      strength: c.strength,
      jimage: c.jimage ?? [0, 0, 0],
    })
  }
  bond_state.bond_connectivity = next

  // Mirror into the SoA bond manager.
  if (bond_manager !== null) {
    bond_manager.apply_atom_delete(deleted_set)
  }

  // Bump fingerprints to the post-delete structure so compute_bond_connectivity
  // treats our state as already up-to-date. Strategy is unchanged.
  const elem_fp = get_element_fingerprint(current_sites)
  bond_state.last_elem_fingerprint = elem_fp
  bond_state.last_bond_fingerprint = `${elem_fp}|${get_position_hash(current_sites).toFixed(4)}`

  // `last_bond_structure` is consulted by build_bond_pairs as the position
  // source when `realtime_position_overrides` is active. Its sites were
  // recorded pre-delete (old indices); leaving it stale would corrupt bond
  // endpoint lookups because bond_connectivity is now in the post-delete
  // index space. Shallow-merge fresh sites onto the previous structure so
  // `lattice` and other non-site fields are preserved. If `last_bond_structure`
  // is null (no prior sync computation), we leave it null — build_bond_pairs
  // will then fall back to the caller-provided `structure` arg.
  //
  // Note: spread-merge assumes `AnyStructure` is a POJO union (which it is in
  // this repo — see $lib/structure/index.ts). A class with getters would lose
  // its prototype here and break downstream `instanceof` checks; not an issue
  // today, but worth keeping in mind if the type shape ever changes.
  if (bond_state.last_bond_structure !== null) {
    bond_state.last_bond_structure = {
      ...bond_state.last_bond_structure,
      sites: current_sites,
    } as AnyStructure
  }

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[atoms-X4] apply_atom_delete_incremental: ${deleted_set.size} atom(s), ${(performance.now() - t0).toFixed(2)}ms`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase X6: incremental atom add / replace / move for bond state
// ─────────────────────────────────────────────────────────────────────────
//
// Unlike delete (X4), these three mutations can both CREATE and DESTROY
// bonds:
//   - add: new atoms may form bonds with existing neighbors; existing bonds
//     are preserved (endpoints unchanged).
//   - replace: changing element changes the covalent radius → some bonds
//     may form, others may break. Topology is NOT preserved in general.
//   - move: changing position changes distances → bonds may form or break.
//     Endpoint site_ids unchanged but geometry can shift.
//
// For X6a the simplification is: on small structures (<= X6_SMALL_THRESHOLD)
// re-run the same `compute_bonds_sync` the main compute path uses, diff the
// result against the existing `bond_state.bond_connectivity`, and apply the
// delta. Above the threshold, return `false` from the caller's `try_X` path
// (the flag-off fallback performs the full recompute via the standard
// `compute_bond_connectivity` $effect on the next tick — same as delete's
// fallback would do).
//
// A perf-tuned "only local neighbors" rebuild is plan X6b territory
// (partial-detect with a neighbor-shell subset structure). The simple
// re-run-and-diff here is correct and measures at ~1–5ms on the ~200-atom
// ceiling; that's already well inside the ≤50ms budget.

/** Size ceiling for the sync re-run-and-diff path. Above this, the caller
 *  returns false and lets the standard $effect.pre path recompute fresh. */
const X6_SMALL_THRESHOLD = 200

/** Canonical bond key (order-insensitive) for diff-by-set. Returns a string
 *  rather than a packed number so there's no collision risk at any realistic
 *  atom count: `${1},${67108864}` and `${2},${0}` hash distinctly. String
 *  interning cost is ~constant per key; V8 reuses the short strings. */
function __bond_key(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`
}

/** Run the same bond detection the main path uses on the given structure.
 *  Phase 5: caller is responsible for passing a pre-ghost structure with
 *  PBC enabled. Returns null if the sync path can't handle the structure
 *  (too large, WASM not ready). */
function __recompute_bonds_sync(
  structure_with_sites: AnyStructure,
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
): Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> | null {
  // Phase 5: caller passes the pre-ghost structure. PBC stays enabled so
  // the detector emits cross-cell bonds with `image` populated; the
  // renderer handles half-cylinder placement against the lattice.
  const result = compute_bonds_sync(structure_with_sites, bonding_strategy, bonding_options as Record<string, number>)
  if (!result) return null
  return result.map(b => ({
    site_idx_1: b.site_idx_1,
    site_idx_2: b.site_idx_2,
    strength: b.strength,
    jimage: (b as { image?: [number, number, number] }).image ?? [0, 0, 0],
  }))
}

/**
 * Apply an atom-add to bond state and (optionally) the SoA bond manager.
 *
 * Runs `compute_bonds_sync` on the post-add structure (full sites list),
 * diffs against `bond_state.bond_connectivity`, and appends only the new
 * bonds that involve at least one newly-added site_id. Existing bonds are
 * untouched (adding an atom never invalidates existing bonds — endpoints
 * don't shift, distances don't change).
 *
 * Falls back (returns false) when:
 *   - `current_sites.length > X6_SMALL_THRESHOLD` (the WASM/async path is
 *     cheaper than the sync re-run+diff; let the legacy $effect handle it)
 *   - `compute_bonds_sync` returns null (WASM not ready / structure too big)
 *
 * Bumps `last_bond_fingerprint` / `last_elem_fingerprint` to `current_sites`
 * on success so the next tick's `compute_bond_connectivity` treats the state
 * as already fresh.
 */
export function apply_atom_add_incremental(
  bond_state: ReturnType<typeof create_bond_state>,
  added: readonly { site_id: number }[],
  bond_manager: BondManager | null,
  current_sites: Site[],
  current_structure: AnyStructure,
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
): boolean {
  const t0 = import.meta.env?.DEV ? performance.now() : 0

  if (added.length === 0) return true
  if (current_sites.length > X6_SMALL_THRESHOLD) return false

  // Fresh bond set for the post-add structure.
  const structure_with_next_sites = { ...current_structure, sites: current_sites } as AnyStructure
  const fresh = __recompute_bonds_sync(structure_with_next_sites, bonding_strategy, bonding_options)
  if (fresh === null) return false

  // Index existing bonds by canonical key so we can identify new ones.
  const prev = bond_state.bond_connectivity
  const prev_keys = new Set<string>()
  for (let i = 0; i < prev.length; i++) {
    prev_keys.add(__bond_key(prev[i].site_idx_1, prev[i].site_idx_2))
  }

  // Additions: bonds present in `fresh` but not in `prev`. For a pure add,
  // all new bonds must involve at least one of the added site_ids — we
  // could filter by that, but `prev_keys` is already tight and saves us
  // from having to materialize the added-sid set for the check.
  const added_bonds: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }> = []
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i]
    if (!prev_keys.has(__bond_key(c.site_idx_1, c.site_idx_2))) {
      added_bonds.push(c)
    }
  }

  // Existing bonds remain valid; append only the new ones. Keeping the
  // existing entries preserves any downstream ordering assumptions.
  if (added_bonds.length > 0) {
    bond_state.bond_connectivity = [...prev, ...added_bonds]
  }

  // Mirror into the SoA bond manager (new pairs only).
  if (bond_manager !== null && added_bonds.length > 0) {
    const n = added_bonds.length
    const pair_buf = new Uint32Array(n * 2)
    const kind_buf = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      pair_buf[i * 2] = added_bonds[i].site_idx_1
      pair_buf[i * 2 + 1] = added_bonds[i].site_idx_2
      kind_buf[i] = BOND_KIND.AUTO
    }
    bond_manager.add_bonds(pair_buf, kind_buf)
  }

  // Bump fingerprints + shallow-merge last_bond_structure (see X4 comment).
  const elem_fp = get_element_fingerprint(current_sites)
  bond_state.last_elem_fingerprint = elem_fp
  bond_state.last_bond_fingerprint = `${elem_fp}|${get_position_hash(current_sites).toFixed(4)}`
  if (bond_state.last_bond_structure !== null) {
    bond_state.last_bond_structure = {
      ...bond_state.last_bond_structure,
      sites: current_sites,
    } as AnyStructure
  } else {
    // First-ever incremental op: seed last_bond_structure so future bond_pair
    // builds under realtime overrides have a position source.
    bond_state.last_bond_structure = structure_with_next_sites
  }

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[atoms-X6] apply_atom_add_incremental: ${added.length} atom(s), +${added_bonds.length} bond(s), ${(performance.now() - t0).toFixed(2)}ms`)
  }
  return true
}

/**
 * Apply an atom-replace (element change) to bond state and bond manager.
 *
 * Changing an atom's element changes its covalent radius, which can both
 * CREATE bonds (radius grew → now reaches previously-too-far neighbor) and
 * DESTROY bonds (radius shrunk → bond now considered too long). For X6a
 * we re-run `compute_bonds_sync` on the post-replace structure and diff
 * against the existing `bond_connectivity` as a set.
 *
 * Same small-structure ceiling and fallback behavior as
 * `apply_atom_add_incremental`.
 */
export function apply_atom_replace_incremental(
  bond_state: ReturnType<typeof create_bond_state>,
  replacements: readonly { site_id: number }[],
  bond_manager: BondManager | null,
  current_sites: Site[],
  current_structure: AnyStructure,
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
): boolean {
  const t0 = import.meta.env?.DEV ? performance.now() : 0

  if (replacements.length === 0) return true
  if (current_sites.length > X6_SMALL_THRESHOLD) return false

  const structure_with_next_sites = { ...current_structure, sites: current_sites } as AnyStructure
  const fresh = __recompute_bonds_sync(structure_with_next_sites, bonding_strategy, bonding_options)
  if (fresh === null) return false

  __apply_full_bond_diff(bond_state, fresh, bond_manager, current_sites, structure_with_next_sites)

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[atoms-X6] apply_atom_replace_incremental: ${replacements.length} atom(s), ${(performance.now() - t0).toFixed(2)}ms`)
  }
  return true
}

/**
 * Apply an atom-move (position change) to bond state and bond manager.
 *
 * Moving an atom can both create and destroy bonds (distances change).
 * Same recompute-and-diff strategy as `apply_atom_replace_incremental`;
 * same small-structure ceiling and fallback.
 *
 * NOTE for X6b: during a drag, this fires on every pointer move and does
 * an O(count²) sync bond recompute. The drag fast-path planned for X6b
 * writes into `realtime_position_overrides` instead of mutating
 * `structure.sites` on each frame, which skips the bond recompute entirely
 * until drop.
 */
export function apply_atom_move_incremental(
  bond_state: ReturnType<typeof create_bond_state>,
  moved: readonly { site_id: number }[],
  bond_manager: BondManager | null,
  current_sites: Site[],
  current_structure: AnyStructure,
  bonding_strategy: BondingStrategy,
  bonding_options: Record<string, unknown>,
): boolean {
  const t0 = import.meta.env?.DEV ? performance.now() : 0

  if (moved.length === 0) return true
  if (current_sites.length > X6_SMALL_THRESHOLD) return false

  const structure_with_next_sites = { ...current_structure, sites: current_sites } as AnyStructure
  const fresh = __recompute_bonds_sync(structure_with_next_sites, bonding_strategy, bonding_options)
  if (fresh === null) return false

  __apply_full_bond_diff(bond_state, fresh, bond_manager, current_sites, structure_with_next_sites)

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[atoms-X6] apply_atom_move_incremental: ${moved.length} atom(s), ${(performance.now() - t0).toFixed(2)}ms`)
  }
  return true
}

/**
 * Shared path for replace + move: the fresh `compute_bonds_sync` result is
 * treated as ground truth. Apply the set-diff against the existing
 * `bond_connectivity`, push remove + add deltas to the SoA bond manager,
 * and bump bond-state fingerprints.
 *
 * The bond_manager delta is order-preserving-for-survivors: we compute the
 * set of existing slots that need removal (bond endpoints no longer in
 * `fresh`), then `remove_bonds` (swap-and-pop). After that, `add_bonds` for
 * the brand-new pairs.
 */
function __apply_full_bond_diff(
  bond_state: ReturnType<typeof create_bond_state>,
  fresh: Array<{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }>,
  bond_manager: BondManager | null,
  current_sites: Site[],
  structure_with_next_sites: AnyStructure,
): void {
  const prev = bond_state.bond_connectivity
  const fresh_keys = new Set<string>()
  for (let i = 0; i < fresh.length; i++) {
    fresh_keys.add(__bond_key(fresh[i].site_idx_1, fresh[i].site_idx_2))
  }
  const prev_keys = new Set<string>()
  for (let i = 0; i < prev.length; i++) {
    prev_keys.add(__bond_key(prev[i].site_idx_1, prev[i].site_idx_2))
  }

  // Ground-truth connectivity is `fresh` — overwrite `bond_connectivity`
  // wholesale. This is simpler than interleaving add+remove on the array
  // and correct (we don't care about prior ordering for the render path;
  // the filter_bonds_during_drag step handles ordering anyway).
  bond_state.bond_connectivity = fresh

  // SoA bond_manager: compute slot removals, then append new pairs.
  if (bond_manager !== null) {
    // Slots whose bond is no longer in fresh → remove.
    const slots_to_remove: number[] = []
    const mgr_count = bond_manager.count
    const pairs = bond_manager.pairs_buffer
    for (let slot = 0; slot < mgr_count; slot++) {
      const a = pairs[slot * 2]
      const b = pairs[slot * 2 + 1]
      if (!fresh_keys.has(__bond_key(a, b))) slots_to_remove.push(slot)
    }
    if (slots_to_remove.length > 0) bond_manager.remove_bonds(slots_to_remove)

    // Brand-new bonds → append.
    const add_list: Array<{ site_idx_1: number; site_idx_2: number }> = []
    for (let i = 0; i < fresh.length; i++) {
      if (!prev_keys.has(__bond_key(fresh[i].site_idx_1, fresh[i].site_idx_2))) {
        add_list.push(fresh[i])
      }
    }
    if (add_list.length > 0) {
      const n = add_list.length
      const pair_buf = new Uint32Array(n * 2)
      const kind_buf = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        pair_buf[i * 2] = add_list[i].site_idx_1
        pair_buf[i * 2 + 1] = add_list[i].site_idx_2
        kind_buf[i] = BOND_KIND.AUTO
      }
      bond_manager.add_bonds(pair_buf, kind_buf)
    }
  }

  // Fingerprints + last_bond_structure (same pattern as X4).
  const elem_fp = get_element_fingerprint(current_sites)
  bond_state.last_elem_fingerprint = elem_fp
  bond_state.last_bond_fingerprint = `${elem_fp}|${get_position_hash(current_sites).toFixed(4)}`
  if (bond_state.last_bond_structure !== null) {
    bond_state.last_bond_structure = {
      ...bond_state.last_bond_structure,
      sites: current_sites,
    } as AnyStructure
  } else {
    bond_state.last_bond_structure = structure_with_next_sites
  }
}
