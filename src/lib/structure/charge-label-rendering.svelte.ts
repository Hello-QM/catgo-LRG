// Charge label rendering logic extracted from StructureScene.svelte.
// Manages charge_label_entries derived state, editing state,
// and document-level drag handling for charge labels.

import type { AnyStructure, Vec3 } from '$lib'
import type { SvelteMap } from 'svelte/reactivity'

/** A single charge label entry for rendering. */
export interface ChargeLabelEntry {
  site_idx: number
  original_idx: number
  charge: number
  position: Vec3
}

/**
 * Minimal atom_manager surface used for live position lookup during
 * trajectory playback. Avoids importing the full AtomManager type to keep
 * this module's import surface small.
 */
export interface PositionsLookup {
  count: number
  site_ids_buffer: Uint32Array
  find_slot_by_site_id: (site_idx: number) => number
  get_x: (slot: number) => number
  get_y: (slot: number) => number
  get_z: (slot: number) => number
}

/**
 * Compute charge label entries from structure and visibility settings.
 * Pure function (no side effects), suitable for use inside $derived.by.
 *
 * Plan v3 follow-up I5 — position priority chain (highest to lowest):
 *   1. realtime_position_overrides (drag wins)
 *   2. trajectory_frame_positions (live trajectory positions; only valid
 *      for site_idx < traj.length / 3 — supercell-extra atoms fall through)
 *   3. atom_manager slot lookup (live GPU positions; covers supercell
 *      atoms whose site_idx is beyond the trajectory cache)
 *   4. structure.sites[i].xyz (load-time fallback; under Architecture P
 *      this is frozen at trajectory-load topology)
 *
 * Without trajectory_frame_positions / atom_manager, charge labels would
 * freeze at trajectory-load positions because Architecture P keeps
 * structure.sites stable per frame. The overlay path lets labels follow
 * the rendered atoms.
 */
export function compute_charge_label_entries(
  structure: AnyStructure | undefined,
  visible_charge_labels: Set<number>,
  show_charge_labels: boolean,
  num_original_sites: number | undefined,
  image_to_original_map: number[] | undefined,
  realtime_position_overrides: Map<number, Vec3> | null,
  trajectory_frame_positions: Float32Array | null = null,
  atom_manager: PositionsLookup | null = null,
): ChargeLabelEntry[] {
  if (!structure?.sites || visible_charge_labels.size === 0 || !show_charge_labels) {
    return []
  }
  const traj_max_site = trajectory_frame_positions ? Math.floor(trajectory_frame_positions.length / 3) : 0
  const entries: ChargeLabelEntry[] = []
  for (let i = 0; i < structure.sites.length; i++) {
    // Map image atoms to their original index
    let orig_idx = i
    if (num_original_sites !== undefined && i >= num_original_sites && image_to_original_map) {
      orig_idx = image_to_original_map[i - num_original_sites] ?? i
    }
    if (!visible_charge_labels.has(orig_idx)) continue
    const charge = structure.sites[orig_idx]?.properties?.bader_charge
    if (typeof charge !== `number`) continue
    // Position priority chain.
    let pos: Vec3 | undefined = realtime_position_overrides?.get(i)
    if (pos === undefined && trajectory_frame_positions && i < traj_max_site) {
      const base = i * 3
      pos = [
        trajectory_frame_positions[base],
        trajectory_frame_positions[base + 1],
        trajectory_frame_positions[base + 2],
      ]
    }
    if (pos === undefined && atom_manager) {
      const slot = atom_manager.find_slot_by_site_id(i)
      if (slot >= 0) {
        pos = [atom_manager.get_x(slot), atom_manager.get_y(slot), atom_manager.get_z(slot)]
      }
    }
    if (pos === undefined) {
      pos = structure.sites[i]?.xyz as Vec3
    }
    if (pos) entries.push({ site_idx: i, original_idx: orig_idx, charge, position: pos })
  }
  return entries
}

/**
 * Set up charge label drag handler (document-level, capture phase).
 * Updates reactive state on every pointermove so Threlte's per-frame re-renders
 * don't overwrite the position via style:transform.
 *
 * Returns a cleanup function. Must be called inside a component `$effect`.
 */
export function setup_charge_label_drag(
  charge_label_offsets: SvelteMap<number, [number, number]> | Map<number, [number, number]>,
  on_charge_label_offset_change: ((idx: number, offset: [number, number]) => void) | undefined,
): () => void {
  let dragging_idx: number | null = null
  let start_x = 0
  let start_y = 0
  let start_offset: [number, number] = [0, 0]
  let drag_started = false

  function on_charge_pointerdown(event: PointerEvent) {
    const target = event.target as HTMLElement
    const label = target.closest?.(`.charge-label[data-charge-site-idx]`) as HTMLElement | null
    if (!label) return
    const idx = Number(label.dataset.chargeSiteIdx)
    if (isNaN(idx)) return
    event.stopPropagation()
    event.preventDefault()
    dragging_idx = idx
    start_x = event.clientX
    start_y = event.clientY
    start_offset = charge_label_offsets.get(idx) ?? [0, 0]
    drag_started = false
    label.setPointerCapture(event.pointerId)
    document.addEventListener(`pointermove`, on_charge_pointermove, true)
    document.addEventListener(`pointerup`, on_charge_pointerup, true)
  }

  function on_charge_pointermove(event: PointerEvent) {
    if (dragging_idx === null) return
    const dx = event.clientX - start_x
    const dy = event.clientY - start_y
    if (!drag_started && Math.hypot(dx, dy) < 3) return
    drag_started = true
    on_charge_label_offset_change?.(dragging_idx, [start_offset[0] + dx, start_offset[1] + dy])
  }

  function on_charge_pointerup(event: PointerEvent) {
    document.removeEventListener(`pointermove`, on_charge_pointermove, true)
    document.removeEventListener(`pointerup`, on_charge_pointerup, true)
    dragging_idx = null
    drag_started = false
  }

  document.addEventListener(`pointerdown`, on_charge_pointerdown, true)
  return () => {
    document.removeEventListener(`pointerdown`, on_charge_pointerdown, true)
    document.removeEventListener(`pointermove`, on_charge_pointermove, true)
    document.removeEventListener(`pointerup`, on_charge_pointerup, true)
  }
}
