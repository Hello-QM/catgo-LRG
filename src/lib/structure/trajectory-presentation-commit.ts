import type { RenderPacket } from './scene/render-packet'
import {
  same_prepared_frame_key,
  type PreparedFrameKey,
} from './trajectory-prepared-frame'

export type PacketSyncEvidence = {
  packet: RenderPacket
  owner: object
  frame_idx: number
  positions_version: number
  topology_version: number
  graph_version: number | null
  bond_count: number
  atom_renderer_synced: boolean
  bond_renderer_synced: boolean
}

export type PreparedPresentationIdentity = {
  prepared_packet: RenderPacket
  key: PreparedFrameKey
  graph_hash: string
  bond_count: number
}

type PresentationHooks = {
  record_presented(
    frame_idx: number,
    positions_version: number,
    graph_hash: string,
    bond_count: number,
  ): void
  record_renderer_installed(
    frame_idx: number,
    positions_version: number,
    graph_hash: string,
    bond_count: number,
  ): void
  acknowledge(frame_idx: number, positions_version: number): void
}

export type TrajectoryPresentationCommitter = {
  publish(
    presentation: PreparedPresentationIdentity,
    owner: `renderer` | `direct`,
  ): boolean
  renderer_synced(
    evidence: PacketSyncEvidence,
    current_display_packet: RenderPacket | null,
    current_prepared_packet: RenderPacket | null,
    latest_key: PreparedFrameKey | null,
  ): boolean
}

function packet_graph_identity(packet: RenderPacket): {
  version: number | null
  bond_count: number
} {
  const graph = packet.topology.bond_graph
  return {
    version: graph?.version ?? null,
    bond_count: (graph?.pairs.length ?? 0) / 2,
  }
}

export function create_trajectory_presentation_committer(
  hooks: PresentationHooks,
): TrajectoryPresentationCommitter {
  let latest: PreparedPresentationIdentity | null = null
  let last_committed_key: PreparedFrameKey | null = null

  const already_committed = (key: PreparedFrameKey): boolean =>
    last_committed_key !== null &&
    same_prepared_frame_key(last_committed_key, key)

  const acknowledge = (
    presentation: PreparedPresentationIdentity,
    renderer_installed: boolean,
  ): boolean => {
    if (already_committed(presentation.key)) return false
    const { frame_idx, positions_version } = presentation.key
    if (renderer_installed) {
      hooks.record_renderer_installed(
        frame_idx,
        positions_version,
        presentation.graph_hash,
        presentation.bond_count,
      )
    } else {
      hooks.record_presented(
        frame_idx,
        positions_version,
        presentation.graph_hash,
        presentation.bond_count,
      )
    }
    last_committed_key = presentation.key
    hooks.acknowledge(frame_idx, positions_version)
    return true
  }

  return {
    publish(presentation, owner) {
      latest = presentation
      return owner === `direct`
        ? acknowledge(presentation, false)
        : false
    },
    renderer_synced(
      evidence,
      current_display_packet,
      current_prepared_packet,
      latest_key,
    ) {
      const presentation = latest
      if (
        presentation === null ||
        current_display_packet === null ||
        current_prepared_packet !== presentation.prepared_packet ||
        latest_key === null ||
        !same_prepared_frame_key(presentation.key, latest_key) ||
        evidence.packet !== current_display_packet ||
        current_display_packet.frame !== presentation.prepared_packet.frame ||
        current_display_packet.topology.bond_graph !==
          presentation.prepared_packet.topology.bond_graph ||
        (!evidence.atom_renderer_synced && !evidence.bond_renderer_synced)
      ) return false

      const frame = current_display_packet.frame
      const graph = packet_graph_identity(current_display_packet)
      if (
        evidence.owner !== frame.owner ||
        evidence.frame_idx !== frame.frame_idx ||
        evidence.positions_version !== frame.positions_version ||
        evidence.topology_version !== current_display_packet.topology.version ||
        evidence.graph_version !== graph.version ||
        evidence.bond_count !== graph.bond_count ||
        evidence.bond_count !== presentation.bond_count
      ) return false

      return acknowledge(presentation, true)
    },
  }
}
