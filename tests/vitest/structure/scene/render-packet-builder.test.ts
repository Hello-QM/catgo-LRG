// gpu-visual-supercell Task 2 — render-packet builder behavior lock.
//
// The builder assembles ONE RenderPacket per effective frame (owner
// structure, trajectory positions/version, current lattice, visual replica
// dims). Visual replication must keep exactly N sites and 3N position floats
// on the CPU; variable-cell frames must use the CURRENT frame lattice; PBC
// image atoms travel as a sparse deduplicated table, never as appended sites.
import { describe, expect, test } from 'vitest'
import {
  assert_render_packet,
  diff_render_packet,
} from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
} from '$lib/structure/scene/render-packet-builder'
import { image_sites_to_instance_table } from '$lib/structure/pbc-image-atoms'
import type { ImageSiteEntry } from '$lib/structure/pbc-image-atoms'
import type { AnyStructure, Site } from '$lib'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function make_structure(n: number, a = 10): AnyStructure {
  const sites = Array.from({ length: n }, (_, idx) => carbon_site([1.4 * idx, 0, 0]))
  return {
    sites,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: a ** 3,
    },
  } as unknown as AnyStructure
}

function make_molecule(n: number): AnyStructure {
  const sites = Array.from({ length: n }, (_, idx) => carbon_site([1.4 * idx, 0, 0]))
  return { sites } as unknown as AnyStructure
}

describe(`create_render_packet_builder`, () => {
  test(`visual 2x2x2 packet keeps topology atom_count N and positions 3N`, () => {
    const structure = make_structure(3)
    const builder = create_render_packet_builder()
    const packet = builder.build({ structure, dims: [2, 2, 2] })
    // Visual replication NEVER expands the CPU-side base data.
    expect(packet.topology.atom_count).toBe(3)
    expect(packet.frame.positions.length).toBe(9)
    expect(packet.replicas.dims).toEqual([2, 2, 2])
    expect(packet.replicas.semantics).toBe(`visual-shared-base`)
    expect(() => assert_render_packet(packet)).not.toThrow()
    // Positions fall back to base site xyz when no frame buffer is given.
    expect(packet.frame.positions[3]).toBeCloseTo(1.4, 5)
    // Topology derives per-atom attributes from the base sites.
    expect([...packet.topology.site_ids]).toEqual([0, 1, 2])
    expect([...packet.topology.atomic_numbers]).toEqual([6, 6, 6])
    expect(packet.topology.radii[0]).toBeCloseTo(0.75, 5)
  })

  test(`variable-cell frame uses frame lattice`, () => {
    const structure = make_structure(2, 10)
    const builder = create_render_packet_builder()
    const frame_positions = new Float32Array([0, 0, 0, 6, 0, 0])
    const packet = builder.build({
      structure,
      frame_positions,
      frame_lattice: [[12, 0, 0], [0, 12, 0], [0, 0, 12]],
      frame_idx: 5,
      positions_version: 3,
      dims: [2, 1, 1],
    })
    // The CURRENT frame lattice wins over the structure lattice (10 Å cube).
    expect([...packet.frame.lattice]).toEqual([12, 0, 0, 0, 12, 0, 0, 0, 12])
    // Frame positions are consumed zero-copy.
    expect(packet.frame.positions).toBe(frame_positions)
    expect(packet.frame.frame_idx).toBe(5)
    expect(packet.frame.positions_version).toBe(3)
    expect(packet.frame.owner).toBe(structure)
  })

  test(`fixed-cell packet falls back to the structure lattice`, () => {
    const structure = make_structure(2, 10)
    const builder = create_render_packet_builder()
    const packet = builder.build({ structure })
    expect([...packet.frame.lattice]).toEqual([10, 0, 0, 0, 10, 0, 0, 0, 10])
  })

  test(`molecule (no lattice) still yields a valid 9-float lattice`, () => {
    const structure = make_molecule(2)
    const builder = create_render_packet_builder()
    const packet = builder.build({ structure })
    expect(packet.frame.lattice.length).toBe(9)
    expect(() => assert_render_packet(packet)).not.toThrow()
  })

  test(`image metadata expands positive ghosts to the outer visual-supercell boundary`, () => {
    const entries: ImageSiteEntry[] = [
      { site_idx: 0, jimage_img: [0, 0, 0] },
      { site_idx: 0, jimage_img: [1, 0, 0] },
      { site_idx: 1, jimage_img: [-1, 1, 0] },
    ]
    const table = image_sites_to_instance_table(entries, [2, 2, 1])
    // Positive base-image offsets move past the final real replica cell; zero
    // (transverse) axes span every real cell. [1,0,0] therefore yields the two
    // x=2 face ghosts at y=0/1; [-1,1,0] is the single (-x,+y) edge ghost.
    expect(table.count).toBe(3)
    expect([...table.base_sites]).toEqual([0, 0, 1])
    expect([...table.jimages]).toEqual([2, 0, 0, 2, 1, 0, -1, 2, 0])
  })

  test(`ghost table deduplicates base_site+jimage`, () => {
    const entries: ImageSiteEntry[] = [
      // Home-cell entry — replica instancing draws it; never a ghost.
      { site_idx: 0, jimage_img: [0, 0, 0] },
      { site_idx: 0, jimage_img: [1, 0, 0] },
      // Exact duplicate of the previous ghost — must collapse.
      { site_idx: 0, jimage_img: [1, 0, 0] },
      { site_idx: 2, jimage_img: [0, -1, 1] },
    ]
    const table = image_sites_to_instance_table(entries)
    expect(table.count).toBe(2)
    expect([...table.base_sites]).toEqual([0, 2])
    expect([...table.jimages]).toEqual([1, 0, 0, 0, -1, 1])
  })

  test(`bond graph conversion retains periodic self-image edges`, () => {
    // Single-atom primitive cell: EVERY bond is a self-image edge. The packet
    // path must not filter them (design §7.2).
    const structure = make_structure(1, 3)
    const builder = create_render_packet_builder()
    const packet = builder.build({
      structure,
      bond_connectivity: [
        { site_idx_1: 0, site_idx_2: 0, strength: 1, jimage: [1, 0, 0] },
        { site_idx_1: 0, site_idx_2: 0, strength: 0.5, jimage: [0, 1, 0] },
      ],
    })
    const graph = packet.topology.bond_graph
    expect(graph).toBeDefined()
    expect(graph!.pairs.length / 2).toBe(2)
    expect([...graph!.pairs]).toEqual([0, 0, 0, 0])
    expect([...graph!.jimages]).toEqual([1, 0, 0, 0, 1, 0])
    expect([...graph!.strengths]).toEqual([1, 0.5])
    expect(() => assert_render_packet(packet)).not.toThrow()
  })

  test(`packets build once — replica-only change reuses topology and frame`, () => {
    const structure = make_structure(2)
    const builder = create_render_packet_builder()
    const first = builder.build({ structure, dims: [1, 1, 1] })
    // Identical inputs → the identical packet object (no rebuild).
    expect(builder.build({ structure, dims: [1, 1, 1] })).toBe(first)
    const replicated = builder.build({ structure, dims: [2, 2, 2] })
    expect(replicated).not.toBe(first)
    // A replica-factor change must NOT invalidate topology/bonds/frame.
    expect(replicated.topology).toBe(first.topology)
    expect(replicated.frame).toBe(first.frame)
    const diff = diff_render_packet(first, replicated)
    expect(diff.replica_changed).toBe(true)
    expect(diff.topology_changed).toBe(false)
    expect(diff.bond_graph_changed).toBe(false)
    expect(diff.frame_changed).toBe(false)
  })

  test(`frame advance changes frame only`, () => {
    const structure = make_structure(2)
    const builder = create_render_packet_builder()
    const frame_a = new Float32Array([0, 0, 0, 1.4, 0, 0])
    const frame_b = new Float32Array([0, 0, 0, 1.5, 0, 0])
    const first = builder.build({
      structure,
      frame_positions: frame_a,
      frame_idx: 0,
      positions_version: 1,
    })
    const second = builder.build({
      structure,
      frame_positions: frame_b,
      frame_idx: 1,
      positions_version: 2,
    })
    expect(second.topology).toBe(first.topology)
    expect(second.replicas).toBe(first.replicas)
    const diff = diff_render_packet(first, second)
    expect(diff.frame_changed).toBe(true)
    expect(diff.topology_changed).toBe(false)
    expect(diff.replica_changed).toBe(false)
  })
})
