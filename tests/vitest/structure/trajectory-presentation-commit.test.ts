import { describe, expect, test, vi } from 'vitest'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import type { PreparedFrameKey } from '$lib/structure/trajectory-prepared-frame'
import {
  create_trajectory_presentation_committer,
  type PacketSyncEvidence,
  type PreparedPresentationIdentity,
} from '$lib/structure/trajectory-presentation-commit'

function fixture(frame_idx = 3, positions_version = 13): {
  key: PreparedFrameKey
  prepared_packet: RenderPacket
  display_packet: RenderPacket
  presentation: PreparedPresentationIdentity
  evidence: PacketSyncEvidence
} {
  const owner = {}
  const graph = {
    version: frame_idx + 20,
    pairs: Uint32Array.of(0, 1),
    jimages: Int8Array.of(0, 0, 0),
    kinds: Uint8Array.of(0),
    strengths: Float32Array.of(1),
  }
  const topology = {
    version: frame_idx + 30,
    atom_count: 2,
    site_ids: Uint32Array.of(0, 1),
    atomic_numbers: Uint8Array.of(6, 6),
    radii: Float32Array.of(1, 1),
    colors: Float32Array.of(1, 1, 1, 1, 1, 1),
    bond_graph: graph,
  }
  const frame = {
    owner,
    frame_idx,
    positions_version,
    positions: Float32Array.of(0, 0, 0, 1, 0, 0),
    lattice: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
  }
  const replicas = {
    version: 1,
    dims: [1, 1, 1] as [number, number, number],
    boundary_policy: `stub` as const,
    semantics: `visual-shared-base` as const,
  }
  const prepared_packet = { topology, frame, replicas }
  const display_packet = {
    topology: { ...topology, version: topology.version + 1 },
    frame,
    replicas,
  }
  const key = {
    owner,
    frame_idx,
    positions_version,
    topology_version: 7,
    topology_fingerprint: `topology`,
    rules_version: `rules`,
  }
  return {
    key,
    prepared_packet,
    display_packet,
    presentation: {
      prepared_packet,
      key,
      graph_hash: `hash-${frame_idx}`,
      bond_count: 1,
    },
    evidence: {
      packet: display_packet,
      owner,
      frame_idx,
      positions_version,
      topology_version: display_packet.topology.version,
      graph_version: graph.version,
      bond_count: 1,
      atom_renderer_synced: true,
      bond_renderer_synced: true,
    },
  }
}

describe(`trajectory presentation committer`, () => {
  test(`publication alone neither acknowledges nor records renderer evidence`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const current = fixture()

    committer.publish(current.presentation)

    expect(record_presented).not.toHaveBeenCalled()
    expect(record_renderer_installed).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })

  test(`commits one matching renderer sync and ignores duplicate and stale events`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const first = fixture()
    committer.publish(first.presentation)

    expect(committer.renderer_synced(
      {
        ...first.evidence,
        packet: { ...first.display_packet },
      },
      first.display_packet,
      first.prepared_packet,
      first.key,
    )).toBe(false)
    expect(committer.renderer_synced(
      {
        ...first.evidence,
        graph_version: first.evidence.graph_version! + 1,
      },
      first.display_packet,
      first.prepared_packet,
      first.key,
    )).toBe(false)
    expect(committer.renderer_synced(
      first.evidence,
      first.display_packet,
      first.prepared_packet,
      first.key,
    )).toBe(true)
    expect(committer.renderer_synced(
      first.evidence,
      first.display_packet,
      first.prepared_packet,
      first.key,
    )).toBe(false)

    const next = fixture(4, 14)
    committer.publish(next.presentation)
    expect(committer.renderer_synced(
      first.evidence,
      first.display_packet,
      first.prepared_packet,
      first.key,
    )).toBe(false)
    expect(committer.renderer_synced(
      next.evidence,
      next.display_packet,
      next.prepared_packet,
      next.key,
    )).toBe(true)

    expect(record_presented).not.toHaveBeenCalled()
    expect(record_renderer_installed).toHaveBeenCalledTimes(2)
    expect(record_renderer_installed).toHaveBeenNthCalledWith(
      1,
      3,
      13,
      `hash-3`,
      1,
    )
    expect(record_renderer_installed).toHaveBeenNthCalledWith(
      2,
      4,
      14,
      `hash-4`,
      1,
    )
    expect(acknowledge.mock.calls).toEqual([[3, 13], [4, 14]])
  })

  test(`falls back directly when the manager packet shape guard prevents a renderer mount`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const install_direct = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const current = fixture()

    committer.publish(current.presentation)
    expect(committer.reconcile(
      current.presentation,
      null,
      current.prepared_packet,
      current.key,
      false,
      false,
      install_direct,
    )).toBe(`direct`)
    expect(committer.reconcile(
      current.presentation,
      null,
      current.prepared_packet,
      current.key,
      false,
      false,
      install_direct,
    )).toBe(`direct`)
    expect(install_direct).toHaveBeenCalledOnce()
    expect(install_direct).toHaveBeenCalledWith(current.presentation)
    expect(record_presented).toHaveBeenCalledOnce()
    expect(record_presented).toHaveBeenCalledWith(
      3,
      13,
      `hash-3`,
      1,
    )
    expect(record_renderer_installed).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledWith(3, 13)
  })

  test(`falls back once when a live unified owner is lost before renderer sync`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const install_direct = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const current = fixture()

    committer.publish(current.presentation)
    expect(committer.reconcile(
      current.presentation,
      current.display_packet,
      current.prepared_packet,
      current.key,
      true,
      false,
      install_direct,
    )).toBe(`renderer`)
    expect(install_direct).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()

    expect(committer.reconcile(
      current.presentation,
      current.display_packet,
      current.prepared_packet,
      current.key,
      false,
      false,
      install_direct,
    )).toBe(`direct`)
    expect(install_direct).toHaveBeenCalledOnce()
    expect(record_presented).toHaveBeenCalledOnce()
    expect(record_renderer_installed).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledOnce()

    // A child effect already queued before ownership loss may still report
    // afterward; it must not turn the direct fallback into a second commit.
    expect(committer.renderer_synced(
      current.evidence,
      current.display_packet,
      current.prepared_packet,
      current.key,
    )).toBe(false)
    expect(record_presented).toHaveBeenCalledOnce()
    expect(record_renderer_installed).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledOnce()
  })

  test(`clear releases the pending presentation and rejects late renderer sync`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const install_direct = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const current = fixture()

    committer.publish(current.presentation)
    committer.clear()

    expect(committer.renderer_synced(
      current.evidence,
      current.display_packet,
      current.prepared_packet,
      current.key,
    )).toBe(false)
    expect(committer.reconcile(
      current.presentation,
      null,
      current.prepared_packet,
      current.key,
      false,
      false,
      install_direct,
    )).toBe(`stale`)
    expect(install_direct).not.toHaveBeenCalled()
    expect(record_presented).not.toHaveBeenCalled()
    expect(record_renderer_installed).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })

  test(`waits for a matching external renderer instead of installing legacy state`, () => {
    const record_presented = vi.fn()
    const record_renderer_installed = vi.fn()
    const acknowledge = vi.fn()
    const install_direct = vi.fn()
    const committer = create_trajectory_presentation_committer({
      record_presented,
      record_renderer_installed,
      acknowledge,
    })
    const current = fixture()
    const external_evidence: PacketSyncEvidence = {
      ...current.evidence,
      packet: current.prepared_packet,
      topology_version: current.prepared_packet.topology.version,
    }

    committer.publish(current.presentation)
    expect(committer.reconcile(
      current.presentation,
      null,
      current.prepared_packet,
      current.key,
      false,
      true,
      install_direct,
    )).toBe(`renderer`)
    expect(install_direct).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()

    expect(committer.external_renderer_synced(
      external_evidence,
      current.prepared_packet,
      current.key,
    )).toBe(true)
    expect(committer.external_renderer_synced(
      external_evidence,
      current.prepared_packet,
      current.key,
    )).toBe(false)
    expect(record_presented).not.toHaveBeenCalled()
    expect(record_renderer_installed).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledWith(3, 13)
  })
})
