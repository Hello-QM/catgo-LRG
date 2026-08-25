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

export type PresentationReconcileResult = `stale` | `renderer` | `direct`

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
  publish(presentation: PreparedPresentationIdentity): void
  reconcile(
    presentation: PreparedPresentationIdentity,
    current_display_packet: RenderPacket | null,
    current_prepared_packet: RenderPacket | null,
    latest_key: PreparedFrameKey | null,
    layer_owned: boolean,
    external_renderer_owned: boolean,
    install_direct: (presentation: PreparedPresentationIdentity) => void,
  ): PresentationReconcileResult
  renderer_synced(
    evidence: PacketSyncEvidence,
    current_display_packet: RenderPacket | null,
    current_prepared_packet: RenderPacket | null,
    latest_key: PreparedFrameKey | null,
  ): boolean
  external_renderer_synced(
    evidence: PacketSyncEvidence,
    current_prepared_packet: RenderPacket | null,
    latest_key: PreparedFrameKey | null,
  ): boolean
  clear(): void
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
  let last_committed: PreparedPresentationIdentity | null = null
  let last_direct_install: PreparedPresentationIdentity | null = null

  const same_presentation = (
    left: PreparedPresentationIdentity,
    right: PreparedPresentationIdentity,
  ): boolean =>
    same_prepared_frame_key(left.key, right.key) &&
    left.graph_hash === right.graph_hash &&
    left.bond_count === right.bond_count

  const is_current = (
    presentation: PreparedPresentationIdentity,
    current_prepared_packet: RenderPacket | null,
    latest_key: PreparedFrameKey | null,
  ): boolean =>
    latest === presentation &&
    current_prepared_packet === presentation.prepared_packet &&
    latest_key !== null &&
    same_prepared_frame_key(presentation.key, latest_key)

  const acknowledge = (
    presentation: PreparedPresentationIdentity,
    renderer_installed: boolean,
  ): boolean => {
    if (
      last_committed !== null &&
      same_presentation(last_committed, presentation)
    ) return false
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
    last_committed = presentation
    hooks.acknowledge(frame_idx, positions_version)
    return true
  }

  return {
    publish(presentation) {
      latest = presentation
    },
    reconcile(
      presentation,
      current_display_packet,
      current_prepared_packet,
      latest_key,
      layer_owned,
      external_renderer_owned,
      install_direct,
    ) {
      if (!is_current(
        presentation,
        current_prepared_packet,
        latest_key,
      )) return `stale`
      if (
        layer_owned &&
        current_display_packet !== null &&
        current_display_packet.frame === presentation.prepared_packet.frame &&
        current_display_packet.topology.bond_graph ===
          presentation.prepared_packet.topology.bond_graph
      ) return `renderer`

      // The WebGPU overlay is a sibling of StructureScene. It consumes the
      // exact prepared packet through the parent bridge and reports its own
      // installation evidence asynchronously. While that renderer is alive,
      // wait for its acknowledgement instead of copying 3N coordinates and a
      // JS bond-object graph into the legacy managers on every frame.
      if (external_renderer_owned) return `renderer`

      if (
        last_direct_install === null ||
        !same_presentation(last_direct_install, presentation)
      ) {
        install_direct(presentation)
        last_direct_install = presentation
      }
      acknowledge(presentation, false)
      return `direct`
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
        !is_current(presentation, current_prepared_packet, latest_key) ||
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
    external_renderer_synced(
      evidence,
      current_prepared_packet,
      latest_key,
    ) {
      const presentation = latest
      if (
        presentation === null ||
        !is_current(presentation, current_prepared_packet, latest_key) ||
        evidence.packet !== presentation.prepared_packet ||
        (!evidence.atom_renderer_synced && !evidence.bond_renderer_synced)
      ) return false

      const packet = presentation.prepared_packet
      const frame = packet.frame
      const graph = packet_graph_identity(packet)
      if (
        evidence.owner !== frame.owner ||
        evidence.frame_idx !== frame.frame_idx ||
        evidence.positions_version !== frame.positions_version ||
        evidence.topology_version !== packet.topology.version ||
        evidence.graph_version !== graph.version ||
        evidence.bond_count !== graph.bond_count ||
        evidence.bond_count !== presentation.bond_count
      ) return false

      return acknowledge(presentation, true)
    },
    clear() {
      latest = null
      last_committed = null
      last_direct_install = null
    },
  }
}
