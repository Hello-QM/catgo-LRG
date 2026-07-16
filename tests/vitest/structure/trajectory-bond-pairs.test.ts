// Behavior guard for build_trajectory_bond_pairs — the per-frame trajectory
// fast path. Locks in stale-bond filtering + jimage semantics so the
// radius-precompute optimization can't change observable output.
import {
  build_trajectory_bond_pairs,
  conn_to_typed_topology,
  get_traj_atomic_numbers,
  typed_table_to_conn,
} from '$lib/structure/bond-computation-controller.svelte'
import type { AnyStructure, Site } from '$lib'
import { describe, expect, test } from 'vitest'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function unknown_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `Xx`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `Xx`,
    properties: {},
  } as unknown as Site
}

const conn = (pairs: Array<[number, number]>) =>
  pairs.map(([site_idx_1, site_idx_2]) => ({ site_idx_1, site_idx_2, strength: 1 }))

describe(`build_trajectory_bond_pairs`, () => {
  test(`builds pairs from flat positions`, () => {
    const positions = new Float32Array([0, 0, 0, 1.4, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([1.4, 0, 0])]
    const pairs = build_trajectory_bond_pairs(
      conn([[0, 1]]),
      positions,
      null,
      null,
      null,
      sites,
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].bond_length).toBeCloseTo(1.4, 5)
    expect(pairs[0].pos_1).toEqual([0, 0, 0])
    expect(pairs[0].pos_2[0]).toBeCloseTo(1.4, 5)
  })

  test(`drops stale bonds beyond (r_a+r_b)*tol*1.5`, () => {
    // C-C covalent radii sum ~1.5 Å → max_dist ≈ 1.5*1.1*1.5 ≈ 2.5 Å.
    // A 10 Å separation is unambiguously stale.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([10, 0, 0])]
    const pairs = build_trajectory_bond_pairs(
      conn([[0, 1]]),
      positions,
      null,
      null,
      null,
      sites,
    )
    expect(pairs).toHaveLength(0)
  })

  test(`keeps bonds when covalent radius unknown (filter skipped)`, () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0])
    const sites = [unknown_site([0, 0, 0]), unknown_site([10, 0, 0])]
    const pairs = build_trajectory_bond_pairs(
      conn([[0, 1]]),
      positions,
      null,
      null,
      null,
      sites,
    )
    expect(pairs).toHaveLength(1)
  })

  test(`tolerance changes re-filter with the same connectivity identity`, () => {
    // Same conn array reference across calls — memoized radii must not
    // freeze the tolerance. 3.0 Å C-C: dropped at tol 1.1 (max ~2.5),
    // kept at tol 2.0 (max ~4.5).
    const shared_conn = conn([[0, 1]])
    const positions = new Float32Array([0, 0, 0, 3, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([3, 0, 0])]
    const strict = build_trajectory_bond_pairs(
      shared_conn,
      positions,
      null,
      null,
      null,
      sites,
      1.1,
    )
    const loose = build_trajectory_bond_pairs(
      shared_conn,
      positions,
      null,
      null,
      null,
      sites,
      2.0,
    )
    expect(strict).toHaveLength(0)
    expect(loose).toHaveLength(1)
  })

  test(`sites identity change invalidates cached radii`, () => {
    const shared_conn = conn([[0, 1]])
    const positions = new Float32Array([0, 0, 0, 10, 0, 0])
    const carbon_sites = [carbon_site([0, 0, 0]), carbon_site([10, 0, 0])]
    const unknown_sites = [unknown_site([0, 0, 0]), unknown_site([10, 0, 0])]
    const filtered = build_trajectory_bond_pairs(
      shared_conn,
      positions,
      null,
      null,
      null,
      carbon_sites,
    )
    const kept = build_trajectory_bond_pairs(
      shared_conn,
      positions,
      null,
      null,
      null,
      unknown_sites,
    )
    expect(filtered).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  test(`cross-cell jimage offsets bond geometry via lattice`, () => {
    const lattice_matrix = [[10, 0, 0], [0, 10, 0], [0, 0, 10]]
    // Atom 1 sits at x=9.3; its jimage [-1,0,0] partner image is at -0.7,
    // 1.4 Å from atom 0 at 0.7 — a valid C-C bond across the cell face.
    const positions = new Float32Array([0.7, 0, 0, 9.3, 0, 0])
    const sites = [carbon_site([0.7, 0, 0]), carbon_site([9.3, 0, 0])]
    const with_image = [{
      site_idx_1: 0,
      site_idx_2: 1,
      strength: 1,
      jimage: [-1, 0, 0] as [number, number, number],
    }]
    const pairs = build_trajectory_bond_pairs(
      with_image,
      positions,
      null,
      null,
      lattice_matrix,
      sites,
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].bond_length).toBeCloseTo(1.4, 4)
    expect(pairs[0].jimage).toEqual([-1, 0, 0])
  })

  test(`typed_table_to_conn converts flat arrays and retains self-image bonds`, () => {
    const table = {
      // bond 0: normal 0-1; bond 1: periodic self-image 2-2@[1,0,0] (KEPT —
      // valid per design §7.2, required for single-atom primitive cells);
      // bond 2: cross-cell 0-2@[0,-1,0]; bond 3: degenerate 3-3@[0,0,0]
      pairs: new Uint32Array([0, 1, 2, 2, 0, 2, 3, 3]),
      images: new Int8Array([0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 0]),
      lengths: new Float32Array([1.4, 2.8, 1.5, 0]),
      strengths: new Float32Array([1, 0.5, 0.8, 0.1]),
    }
    const conn = typed_table_to_conn(table)
    expect(conn).toHaveLength(4)
    expect(conn[0]).toEqual({
      site_idx_1: 0,
      site_idx_2: 1,
      strength: 1,
      jimage: [0, 0, 0],
    })
    expect(conn[1]).toEqual({
      site_idx_1: 2,
      site_idx_2: 2,
      strength: 0.5,
      jimage: [1, 0, 0],
    })
    expect(conn[2].jimage).toEqual([0, -1, 0])
    expect(conn[2].strength).toBeCloseTo(0.8, 5)
    expect(conn[3].site_idx_1).toBe(3)
  })

  test(`get_traj_atomic_numbers maps elements and memoizes on sites identity`, () => {
    const sites = [carbon_site([0, 0, 0]), carbon_site([1, 0, 0])]
    const zs = get_traj_atomic_numbers(sites)
    expect(zs).toBeInstanceOf(Uint8Array)
    expect([...zs!]).toEqual([6, 6])
    // memoized: same identity → same array back
    expect(get_traj_atomic_numbers(sites)).toBe(zs)
    // unknown element → null (typed path unusable)
    const bad = [carbon_site([0, 0, 0]), unknown_site([1, 0, 0])]
    expect(get_traj_atomic_numbers(bad)).toBeNull()
  })

  test(`conn_to_typed_topology builds flat topology matching the object path`, () => {
    const lattice_matrix = [[10, 0, 0], [0, 10, 0], [0, 0, 10]]
    const positions = new Float32Array([0.7, 0, 0, 9.3, 0, 0, 2.1, 0, 0])
    const sites = [
      carbon_site([0.7, 0, 0]),
      carbon_site([9.3, 0, 0]),
      carbon_site([2.1, 0, 0]),
    ]
    const connectivity = [
      { site_idx_1: 0, site_idx_2: 2, strength: 1 },
      {
        site_idx_1: 0,
        site_idx_2: 1,
        strength: 1,
        jimage: [-1, 0, 0] as [number, number, number],
      },
    ]
    const topo = conn_to_typed_topology(connectivity, positions, lattice_matrix, sites)
    expect(topo).not.toBeNull()
    expect(topo!.count).toBe(2)
    expect([...topo!.pairs.subarray(0, 4)]).toEqual([0, 2, 0, 1])
    expect([...topo!.jimages.subarray(0, 6)]).toEqual([0, 0, 0, -1, 0, 0])
  })

  test(`conn_to_typed_topology drops stale bonds like the object path`, () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 1.4, 0, 0])
    const sites = [
      carbon_site([0, 0, 0]),
      carbon_site([10, 0, 0]),
      carbon_site([1.4, 0, 0]),
    ]
    const connectivity = conn([[0, 1], [0, 2]])
    const topo = conn_to_typed_topology(connectivity, positions, null, sites)
    expect(topo!.count).toBe(1)
    expect([...topo!.pairs.subarray(0, 2)]).toEqual([0, 2])
  })

  test(`conn_to_typed_topology keeps unknown-radius bonds but honors the hard cap`, () => {
    const positions = new Float32Array([0, 0, 0, 3, 0, 0, 10, 0, 0])
    const sites = [
      unknown_site([0, 0, 0]),
      unknown_site([3, 0, 0]),
      unknown_site([10, 0, 0]),
    ]
    // Radius unknown → stale filter skipped for both; the 10 Å bond must
    // still fall to the caller-supplied hard cap (matches MAX_BOND_LENGTH).
    const connectivity = conn([[0, 1], [0, 2]])
    const topo = conn_to_typed_topology(connectivity, positions, null, sites, undefined, 4.0)
    expect(topo!.count).toBe(1)
    expect([...topo!.pairs.subarray(0, 2)]).toEqual([0, 1])
  })

  test(`conn_to_typed_topology keeps self-image bonds, drops non-finite geometry`, () => {
    // Periodic self-image edges (a === b, jimage != 0) are valid (design
    // §7.2) — a 1.5 Å lattice keeps the self bond under the C-C stale cap.
    const positions = new Float32Array([0, 0, 0, 1.4, 0, 0, NaN, 0, 0])
    const sites = [
      carbon_site([0, 0, 0]),
      carbon_site([1.4, 0, 0]),
      carbon_site([0, 0, 0]),
    ]
    const connectivity = [
      { site_idx_1: 0, site_idx_2: 1, strength: 1 },
      {
        site_idx_1: 1,
        site_idx_2: 1,
        strength: 1,
        jimage: [1, 0, 0] as [number, number, number],
      },
      { site_idx_1: 0, site_idx_2: 2, strength: 1 },
    ]
    const topo = conn_to_typed_topology(
      connectivity,
      positions,
      [[1.5, 0, 0], [0, 1.5, 0], [0, 0, 1.5]],
      sites,
    )
    expect(topo!.count).toBe(2)
    expect([...topo!.pairs.subarray(0, 4)]).toEqual([0, 1, 1, 1])
    expect([...topo!.jimages.subarray(0, 6)]).toEqual([0, 0, 0, 1, 0, 0])
  })

  test(`wasm_bonds_to_pairs retains periodic self-image bonds`, async () => {
    const { wasm_bonds_to_pairs } = await import(
      '$lib/structure/workers/bond-worker-api'
    )
    // Single-atom primitive cell (FCC/BCC metals): the ONLY bonds are
    // self-image edges — the old a==b starburst filter dropped all of them.
    const structure = { sites: [carbon_site([0, 0, 0])] } as unknown as AnyStructure
    const wasm_bonds = [
      {
        site_idx_1: 0,
        site_idx_2: 0,
        bond_length: 3,
        strength: 1,
        image: [1, 0, 0] as [number, number, number],
      },
      {
        site_idx_1: 0,
        site_idx_2: 0,
        bond_length: 3,
        strength: 1,
        image: [0, -1, 0] as [number, number, number],
      },
    ]
    const pairs = wasm_bonds_to_pairs(wasm_bonds, structure)
    expect(pairs).toHaveLength(2)
    expect(pairs[0].site_idx_1).toBe(0)
    expect(pairs[0].site_idx_2).toBe(0)
    expect(pairs[0].jimage).toEqual([1, 0, 0])
    expect(pairs[1].jimage).toEqual([0, -1, 0])
  })

  test(`conn_to_typed_topology bails to null on out-of-coverage site indices`, () => {
    // Supercell-extra atom (index 5 beyond the 2-atom frame buffer) → the
    // typed path can't resolve its position; caller must fall back.
    const positions = new Float32Array([0, 0, 0, 1.4, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([1.4, 0, 0])]
    const connectivity = conn([[0, 5]])
    expect(conn_to_typed_topology(connectivity, positions, null, sites)).toBeNull()
  })

  test(`conn_to_typed_topology reuses its scratch buffers across calls`, () => {
    // Contract: the returned arrays are valid only until the next call —
    // consumers must copy synchronously (replace_auto_bonds does).
    const positions = new Float32Array([0, 0, 0, 1.4, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([1.4, 0, 0])]
    const first = conn_to_typed_topology(conn([[0, 1]]), positions, null, sites)
    const second = conn_to_typed_topology(conn([[0, 1]]), positions, null, sites)
    expect(second!.pairs).toBe(first!.pairs)
    expect(second!.jimages).toBe(first!.jimages)
  })

  test(`overrides take precedence over trajectory positions`, () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0])
    const sites = [carbon_site([0, 0, 0]), carbon_site([10, 0, 0])]
    const overrides = new Map<number, [number, number, number]>([[1, [1.4, 0, 0]]])
    const pairs = build_trajectory_bond_pairs(
      conn([[0, 1]]),
      positions,
      overrides,
      null,
      null,
      sites,
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].bond_length).toBeCloseTo(1.4, 5)
  })
})
