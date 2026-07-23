import type {
  BaseBondGraph,
  RenderPacket,
} from './scene/render-packet'

export type PreparedFrameKey = {
  owner: object
  frame_idx: number
  positions_version: number
  topology_version: number
  rules_version: string
}

export type PreparedTrajectoryFrame = {
  key: PreparedFrameKey
  packet: RenderPacket
  graph: BaseBondGraph
  gpu_positions_rgba: Float32Array
  forces: Float32Array | null
  graph_hash: string
  byte_size: number
  compute_ms: number
}

export type PreparedFrameOutcome =
  | { status: 'ready'; value: PreparedTrajectoryFrame; cache_hit: boolean }
  | { status: 'stale' }
  | { status: 'failed'; error: Error }

export function same_prepared_frame_key(
  a: PreparedFrameKey,
  b: PreparedFrameKey,
): boolean {
  return a.owner === b.owner &&
    a.frame_idx === b.frame_idx &&
    a.positions_version === b.positions_version &&
    a.topology_version === b.topology_version &&
    a.rules_version === b.rules_version
}

export function prepared_frame_byte_size(
  packet: RenderPacket,
  rgba: Float32Array,
  forces: Float32Array | null,
): number {
  const { topology, frame, replicas } = packet
  const graph = topology.bond_graph
  let bytes = frame.positions.byteLength +
    frame.lattice.byteLength +
    rgba.byteLength +
    (forces?.byteLength ?? 0) +
    topology.site_ids.byteLength +
    topology.atomic_numbers.byteLength +
    topology.radii.byteLength +
    topology.colors.byteLength +
    (replicas.physical_site_map?.byteLength ?? 0)

  if (graph) {
    bytes += graph.pairs.byteLength +
      graph.jimages.byteLength +
      graph.kinds.byteLength +
      graph.strengths.byteLength
  }
  return bytes
}
