/**
 * Shared render contract for the trajectory / visual-supercell renderers.
 *
 * These are PURE types + allocation-lean validators. They live outside any
 * Svelte component so their invariants can be unit tested and so the WebGPU and
 * WebGL2 adapters consume an identical `RenderPacket`. No Three.js / Svelte /
 * Threlte imports — only data in, data out.
 *
 * Design: docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md
 * (section 5 "Core render contract"; sections 7.1–7.3 for semantics).
 */

/**
 * Immutable-per-topology attributes of the base scientific cell. Visual
 * replication never changes `atom_count` — exactly N sites and 3N position
 * floats stay on the CPU.
 */
export type BaseTopology = {
  version: number
  atom_count: number
  site_ids: Uint32Array
  atomic_numbers: Uint8Array
  radii: Float32Array
  /** Packed rgb (3 floats) or rgba (4 floats) per base atom. */
  colors: Float32Array
  bond_graph?: BaseBondGraph
}

/**
 * One bond graph for the base cell. Each bond records its two base endpoint
 * indices in `pairs` (2 entries per bond) and the periodic image offset applied
 * to endpoint B in `jimages` (3 entries per bond). Periodic self-image edges
 * (`a === b` with non-zero jimage) are valid and are NOT filtered here.
 */
export type BaseBondGraph = {
  version: number
  /** 2 × bond_count — [a0, b0, a1, b1, …]. */
  pairs: Uint32Array
  /** 3 × bond_count — [jx0, jy0, jz0, …], the image offset on endpoint B. */
  jimages: Int8Array
  /** 1 × bond_count. */
  kinds: Uint8Array
  /** 1 × bond_count. */
  strengths: Float32Array
}

/**
 * Per-frame geometry. `positions` is base-sized (3 × atom_count). `lattice` is
 * the CURRENT frame lattice (9 floats, row-major, rows = a,b,c) — variable-cell
 * trajectories carry a different lattice each frame.
 */
export type FrameGeometry = {
  owner: object
  frame_idx: number
  positions_version: number
  positions: Float32Array
  lattice: Float32Array
}

export type BoundaryPolicy = 'stub' | 'hide' | 'ghost-images'
export type ReplicaSemantics = 'visual-shared-base' | 'physical-distinct-sites'

/**
 * Visual replication layout. A replica-factor change bumps `version`, changes
 * draw instance counts + uniforms, and must NOT invalidate base-cell bonds.
 *
 * `physical_site_map` is present only for `physical-distinct-sites` layouts
 * (true Build supercells): it is indexed atom-major by
 * `instance_index = base_site + base_count · cell_index` and yields the unique
 * physical site id for that (atom, cell).
 */
export type ReplicaLayout = {
  version: number
  dims: readonly [number, number, number]
  boundary_policy: BoundaryPolicy
  semantics: ReplicaSemantics
  physical_site_map?: Uint32Array
}

export type RenderPacket = {
  topology: BaseTopology
  frame: FrameGeometry
  replicas: ReplicaLayout
}

/**
 * Sparse, deduplicated table of ghost image instances required by the
 * `ghost-images` boundary policy. Each ghost is identified by its base site and
 * the absolute image offset (relative to the base origin) it is drawn at.
 */
export type ImageInstanceTable = {
  count: number
  base_sites: Uint32Array
  /** 3 × count — [jx, jy, jz] per ghost. */
  jimages: Int8Array
}

/**
 * Result of a GPU pick. For `kind: 'bond'`, `base_site` is the bond graph
 * index — bond picks resolve to that index unchanged and NEVER map through
 * `physical_site_map` (see `logical_site_for_pick`). `cell` is the replica
 * cell of the picked instance; for a ghost it is the absolute image cell and
 * may lie outside `[0, dims)`. `ghost` marks a pick on a ghost image instance
 * (folds back to the base site under `visual-shared-base`; wraps into the
 * supercell under `physical-distinct-sites`).
 */
export type ReplicaPickResult = {
  kind: 'atom' | 'bond' | 'miss'
  base_site: number
  cell: readonly [number, number, number]
  ghost: boolean
}

/** What changed between two packets. A replica-only change leaves
 *  `topology_changed`, `bond_graph_changed`, and `frame_changed` false so
 *  callers do not rerun bond detection. */
export type RenderPacketDiff = {
  topology_changed: boolean
  bond_graph_changed: boolean
  frame_changed: boolean
  replica_changed: boolean
}

/**
 * Validate the structural invariants of a `RenderPacket`. Throws a descriptive
 * `Error` on the first violation; returns nothing on success. Allocation-free.
 */
export function assert_render_packet(packet: RenderPacket): void {
  const { topology: t, frame: f, replicas: r } = packet
  const n = t.atom_count
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`RenderPacket: atom_count must be a non-negative integer, got ${n}`)
  }
  if (t.site_ids.length !== n) {
    throw new Error(
      `RenderPacket: site_ids.length (${t.site_ids.length}) !== atom_count (${n})`,
    )
  }
  if (t.atomic_numbers.length !== n) {
    throw new Error(
      `RenderPacket: atomic_numbers.length (${t.atomic_numbers.length}) !== ` +
        `atom_count (${n})`,
    )
  }
  if (t.radii.length !== n) {
    throw new Error(`RenderPacket: radii.length (${t.radii.length}) !== atom_count (${n})`)
  }
  if (t.colors.length !== n * 3 && t.colors.length !== n * 4) {
    throw new Error(
      `RenderPacket: colors.length (${t.colors.length}) must be 3× or 4× ` +
        `atom_count (${n})`,
    )
  }
  if (f.positions.length !== n * 3) {
    throw new Error(
      `RenderPacket: positions.length (${f.positions.length}) !== 3 × atom_count ` +
        `(${n * 3})`,
    )
  }
  if (f.lattice.length !== 9) {
    throw new Error(`RenderPacket: lattice must be 9 floats, got ${f.lattice.length}`)
  }
  if (t.bond_graph) assert_bond_graph(t.bond_graph)
  const [nx, ny, nz] = r.dims
  if (
    !Number.isInteger(nx) || !Number.isInteger(ny) || !Number.isInteger(nz) ||
    nx < 1 || ny < 1 || nz < 1
  ) {
    throw new Error(
      `RenderPacket: replica dims must be integers ≥ 1, got [${nx}, ${ny}, ${nz}]`,
    )
  }
  if (r.semantics === 'physical-distinct-sites') {
    if (!r.physical_site_map) {
      throw new Error(
        `RenderPacket: semantics 'physical-distinct-sites' requires a ` +
          `physical_site_map`,
      )
    }
    const expected = n * nx * ny * nz
    if (r.physical_site_map.length !== expected) {
      throw new Error(
        `RenderPacket: physical_site_map.length (${r.physical_site_map.length}) !== ` +
          `atom_count × ∏dims (${expected})`,
      )
    }
  }
}

function assert_bond_graph(bg: BaseBondGraph): void {
  if (bg.pairs.length % 2 !== 0) {
    throw new Error(`BaseBondGraph: pairs.length (${bg.pairs.length}) must be even`)
  }
  const bond_count = bg.pairs.length / 2
  if (bg.jimages.length !== bond_count * 3) {
    throw new Error(
      `BaseBondGraph: jimages.length (${bg.jimages.length}) !== 3 × bond_count ` +
        `(${bond_count * 3})`,
    )
  }
  if (bg.kinds.length !== bond_count) {
    throw new Error(
      `BaseBondGraph: kinds.length (${bg.kinds.length}) !== bond_count (${bond_count})`,
    )
  }
  if (bg.strengths.length !== bond_count) {
    throw new Error(
      `BaseBondGraph: strengths.length (${bg.strengths.length}) !== bond_count ` +
        `(${bond_count})`,
    )
  }
}

/**
 * Report which of topology / bond-graph / frame / replica changed between two
 * packets, by comparing their independent versions (plus frame identity). A
 * replica-only change is distinguishable so callers do not invalidate bonds.
 * Allocation-free apart from the small result object.
 */
export function diff_render_packet(
  prev: RenderPacket,
  next: RenderPacket,
): RenderPacketDiff {
  return {
    topology_changed: prev.topology.version !== next.topology.version,
    bond_graph_changed: prev.topology.bond_graph?.version !==
      next.topology.bond_graph?.version,
    frame_changed: prev.frame.owner !== next.frame.owner ||
      prev.frame.frame_idx !== next.frame.frame_idx ||
      prev.frame.positions_version !== next.frame.positions_version,
    replica_changed: prev.replicas.version !== next.replicas.version,
  }
}
