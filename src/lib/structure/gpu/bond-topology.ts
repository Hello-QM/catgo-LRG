import type { AnyStructure, BondPair } from '$lib/structure'
import {
  build_sites_to_draw,
  make_image_site_key,
  type BondConnectivityEntry,
} from '$lib/structure/pbc-image-atoms'
import { pack_jimage } from '$lib/structure/gpu/bond-compute'

export type LargeSystemExternalBondTopology = {
  /** Packed visible bond pairs: a, b, packed-jimage per bond. */
  pairs: Uint32Array
  count: number
  /**
   * Packed image-atom decorator records:
   *   slot, orig_site_idx, packed-image-jimage, flags
   * where flags bit0 = partner image is also drawn.
   */
  decorators: Uint32Array
  decorator_count: number
}

const EMPTY_TOPOLOGY: LargeSystemExternalBondTopology = Object.freeze({
  pairs: new Uint32Array(0),
  count: 0,
  decorators: new Uint32Array(0),
  decorator_count: 0,
}) as LargeSystemExternalBondTopology

type BuildExternalBondTopologyOptions = {
  show_image_atoms: boolean
  hide_incomplete_bonds: boolean
  include_decorators?: boolean
}

function as_jimage(bond: BondPair): [number, number, number] {
  const j = bond.jimage ?? [0, 0, 0]
  return [j[0] | 0, j[1] | 0, j[2] | 0]
}

function is_home_jimage(j: readonly [number, number, number]): boolean {
  return j[0] === 0 && j[1] === 0 && j[2] === 0
}

function add_slot(slots_by_atom: Map<number, number[]>, atom_idx: number, slot: number): void {
  let slots = slots_by_atom.get(atom_idx)
  if (slots === undefined) {
    slots = []
    slots_by_atom.set(atom_idx, slots)
  }
  slots.push(slot)
}

/**
 * Convert the standard WebGL viewer's already-filtered bond list into the
 * compact topology the WebGPU large-system overlay consumes.
 *
 * The key point is that cross-cell / boundary bond display is not just a
 * nearest-neighbour question. The WebGL path first decides which PBC image atoms
 * are actually drawn (`sites_to_draw`), then its decorator pass draws or hides
 * the corresponding boundary bond halves. This helper mirrors that pure
 * topology math so large-system mode can behave as a backend swap instead of a
 * separate periodic-visualization implementation.
 */
export function build_external_bond_topology(
  bonds: readonly BondPair[] | null | undefined,
  source_structure: AnyStructure | null | undefined,
  options: BuildExternalBondTopologyOptions,
): LargeSystemExternalBondTopology {
  const count = bonds?.length ?? 0
  if (count === 0) return EMPTY_TOPOLOGY

  const pairs = new Uint32Array(count * 3)
  const connectivity: BondConnectivityEntry[] = new Array(count)
  const slots_by_atom = new Map<number, number[]>()

  for (let slot = 0; slot < count; slot++) {
    const bond = bonds![slot]
    const a = bond.site_idx_1 >>> 0
    const b = bond.site_idx_2 >>> 0
    const j = as_jimage(bond)
    pairs[slot * 3] = a
    pairs[slot * 3 + 1] = b
    pairs[slot * 3 + 2] = pack_jimage(j[0], j[1], j[2])
    connectivity[slot] = {
      site_idx_1: a,
      site_idx_2: b,
      jimage: j,
      strength: bond.strength,
    }
    add_slot(slots_by_atom, a, slot)
    if (a !== b) add_slot(slots_by_atom, b, slot)
  }

  const has_lattice = !!(source_structure as { lattice?: unknown } | null | undefined)?.lattice
  if (!options.include_decorators || !source_structure || !has_lattice) {
    return { pairs, count, decorators: new Uint32Array(0), decorator_count: 0 }
  }

  const sites_to_draw = build_sites_to_draw(source_structure, connectivity, {
    draw_image_atoms: options.show_image_atoms,
    bonded_sites_outside_unit_cell: false,
    edge_tolerance: 0.05,
  })

  const decorator_records: number[] = []
  for (const entry of sites_to_draw.values()) {
    const image_j = entry.jimage_img
    if (is_home_jimage(image_j)) continue
    const slots = slots_by_atom.get(entry.site_idx)
    if (slots === undefined) continue
    for (const slot of slots) {
      const bond = bonds![slot]
      const a = bond.site_idx_1 >>> 0
      const b = bond.site_idx_2 >>> 0
      const j = as_jimage(bond)
      const anchor_is_a = a === (entry.site_idx >>> 0)
      const partner_idx = anchor_is_a ? b : a
      const partner_j: [number, number, number] = anchor_is_a
        ? [image_j[0] + j[0], image_j[1] + j[1], image_j[2] + j[2]]
        : [image_j[0] - j[0], image_j[1] - j[1], image_j[2] - j[2]]
      const partner_drawn = sites_to_draw.has(make_image_site_key(partner_idx, partner_j))
      if (options.hide_incomplete_bonds && !partner_drawn) continue
      decorator_records.push(
        slot >>> 0,
        entry.site_idx >>> 0,
        pack_jimage(image_j[0], image_j[1], image_j[2]),
        partner_drawn ? 1 : 0,
      )
    }
  }

  return {
    pairs,
    count,
    decorators: new Uint32Array(decorator_records),
    decorator_count: decorator_records.length / 4,
  }
}
