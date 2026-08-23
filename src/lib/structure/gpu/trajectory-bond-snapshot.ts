import type {
  BaseBondGraph,
  RenderPacket,
} from '$lib/structure/scene/render-packet'

/** Packet-owned empty graph used while an expected trajectory snapshot fails
 *  its identity gate. Keeping packet ownership active prevents a legacy async
 *  detector from publishing a graph for a different presentation generation. */
export const EMPTY_TRAJECTORY_BOND_GRAPH: BaseBondGraph = {
  version: -1,
  pairs: new Uint32Array(0),
  jimages: new Int8Array(0),
  kinds: new Uint8Array(0),
  strengths: new Float32Array(0),
}

/**
 * Return the exact bond graph only when it belongs to the positions currently
 * presented by the trajectory player.
 *
 * The prepared-frame pipeline deliberately keeps positions and connectivity in
 * one immutable packet. Identity-checking the position buffer is both cheaper
 * and stronger than comparing frame numbers alone: a seek or an in-place edit
 * may reuse an index while publishing a different position version.
 */
export function matching_trajectory_bond_graph(
  packet: RenderPacket | null | undefined,
  positions: Float32Array | null | undefined,
  frame_idx: number,
  atom_count: number,
): BaseBondGraph | null {
  if (!packet || !positions || !packet.topology.bond_graph) return null
  if (packet.frame.positions !== positions) return null
  if (packet.frame.frame_idx !== frame_idx) return null
  if (packet.topology.atom_count !== atom_count) return null
  if (positions.length !== atom_count * 3) return null
  return packet.topology.bond_graph
}
