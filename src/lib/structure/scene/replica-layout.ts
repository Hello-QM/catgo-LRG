/**
 * Replica oracle — allocation-lean pure helpers that turn the shared render
 * contract into per-instance decode, per-cell translation, and periodic-edge
 * resolution. Consumed identically by the WebGPU and WebGL2 adapters.
 *
 * Instance order is ATOM-MAJOR, matching the existing WebGPU decode
 * (`large-system-renderer.ts`):
 *
 *   instance_index = atom_index + base_count · cell_index
 *   cell_index     = ix + nx · (iy + ny · iz)          (x-fastest, then y, z)
 *
 * The current frame lattice (9 floats, row-major, rows = a,b,c) drives every
 * translation, so variable-cell trajectories replicate against the live cell.
 *
 * Design: docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md
 */

import type {
  BaseBondGraph,
  BoundaryPolicy,
  ImageInstanceTable,
  ReplicaLayout,
  ReplicaPickResult,
} from './render-packet'

type Cell = readonly [number, number, number]
type Vec3 = [number, number, number]

/** A single base bond: endpoint indices + the image offset applied to B. */
export type PeriodicBond = {
  a: number
  b: number
  jimage: Cell
}

/** Decoded replica instance: which base atom, and which replica cell. */
export type ReplicaInstance = {
  atom_index: number
  cell: Vec3
  cell_index: number
}

/**
 * Resolution of one base bond within one replica cell. `a_cell` is the cell of
 * endpoint A (the input cell); `b_cell` is the image cell of endpoint B
 * (`cell + jimage`). `omit` carries no geometry.
 */
export type ResolvedEdge =
  | { kind: 'complete'; a_cell: Vec3; b_cell: Vec3; ghost: false }
  | { kind: 'stub'; a_cell: Vec3; b_cell: Vec3; ghost: false }
  | { kind: 'ghost'; a_cell: Vec3; b_cell: Vec3; ghost: true }
  | { kind: 'omit' }

/**
 * Mutable out-record for the allocation-free form of `resolve_periodic_edge`.
 * Callers allocate one and reuse it across every bond × cell probe. When
 * `kind === 'omit'` the cell tuples are still written (handy for debugging)
 * but carry no geometry, matching the `omit` variant of `ResolvedEdge`.
 */
export type ResolvedEdgeState = {
  kind: 'complete' | 'stub' | 'ghost' | 'omit'
  a_cell: Vec3
  b_cell: Vec3
  ghost: boolean
}

/**
 * Decode an atom-major `instance_index` into its base atom and replica cell.
 * The inverse of `instance_index = atom_index + base_count · cell_index`.
 *
 * Pass `out` to make the call allocation-free: the record and its inner `cell`
 * tuple are mutated in place and returned. Omitting `out` allocates a fresh
 * record (fine off the hot path).
 */
export function decode_replica_instance(
  instance_index: number,
  base_count: number,
  dims: Cell,
  out?: ReplicaInstance,
): ReplicaInstance {
  const bc = base_count > 0 ? base_count : 1
  const atom_index = instance_index % bc
  const cell_index = (instance_index - atom_index) / bc
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const ix = cell_index % nx
  const iy = Math.floor(cell_index / nx) % ny
  const iz = Math.floor(cell_index / (nx * ny))
  if (out) {
    out.atom_index = atom_index
    out.cell[0] = ix
    out.cell[1] = iy
    out.cell[2] = iz
    out.cell_index = cell_index
    return out
  }
  return { atom_index, cell: [ix, iy, iz], cell_index }
}

/**
 * Encode a replica cell into its atom-major cell index (x-fastest, then y,z).
 *
 * Range-guarded: returns -1 when any component lies outside `[0, dims)`.
 * Without the guard, out-of-range cells (e.g. a ghost's cell `[-1,1,0]` with
 * dims `[3,2,1]`) silently alias the index of a DIFFERENT in-range replica.
 * Callers with possibly-unnormalized cells (ghosts) must wrap them into the
 * supercell first — see `logical_site_for_pick`.
 */
export function encode_cell_index(cell: Cell, dims: Cell): number {
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const nz = dims[2] > 0 ? dims[2] : 1
  if (
    cell[0] < 0 || cell[0] >= nx ||
    cell[1] < 0 || cell[1] >= ny ||
    cell[2] < 0 || cell[2] >= nz
  ) {
    return -1
  }
  return cell[0] + nx * (cell[1] + ny * cell[2])
}

/**
 * Cartesian translation of a replica cell: `ix·a + iy·b + iz·c` using the
 * CURRENT frame `lattice` (9 floats, row-major, rows = a,b,c). Writes into the
 * provided `out` tuple (allocation-free when the caller reuses it) and returns
 * it.
 */
export function replica_translation(
  cell: Cell,
  lattice: ArrayLike<number>,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const [ix, iy, iz] = cell
  out[0] = ix * lattice[0] + iy * lattice[3] + iz * lattice[6]
  out[1] = ix * lattice[1] + iy * lattice[4] + iz * lattice[7]
  out[2] = ix * lattice[2] + iy * lattice[5] + iz * lattice[8]
  return out
}

/**
 * Resolve one base bond within replica `cell` under `policy`, evaluating
 * `cell + jimage` for endpoint B. Periodic self-image edges (`a === b` with
 * non-zero jimage) are valid and never filtered.
 *
 * - inside supercell            → `complete` bond to the real replica
 * - outside + `stub`            → `stub` edge toward the phantom neighbor
 * - outside + `hide`            → `omit`
 * - outside + `ghost-images`    → `ghost` instance + complete bond to the ghost
 *
 * Pass `out` to make the call allocation-free: the record and its `a_cell` /
 * `b_cell` tuples are mutated in place and returned. Omitting `out` allocates
 * a fresh result per call (fine off the hot path).
 */
export function resolve_periodic_edge(
  bond: PeriodicBond,
  cell: Cell,
  dims: Cell,
  policy: BoundaryPolicy,
  out?: ResolvedEdgeState,
): ResolvedEdge {
  const ax = cell[0]
  const ay = cell[1]
  const az = cell[2]
  const bx = ax + bond.jimage[0]
  const by = ay + bond.jimage[1]
  const bz = az + bond.jimage[2]
  const inside = bx >= 0 && bx < dims[0] && by >= 0 && by < dims[1] &&
    bz >= 0 && bz < dims[2]
  let kind: ResolvedEdgeState['kind']
  if (inside) kind = 'complete'
  else if (policy === 'stub') kind = 'stub'
  else if (policy === 'hide') kind = 'omit'
  else kind = 'ghost'
  if (out) {
    out.kind = kind
    out.ghost = kind === 'ghost'
    out.a_cell[0] = ax
    out.a_cell[1] = ay
    out.a_cell[2] = az
    out.b_cell[0] = bx
    out.b_cell[1] = by
    out.b_cell[2] = bz
    // ResolvedEdgeState is field-compatible with every ResolvedEdge variant;
    // the runtime kind/ghost pairing is enforced above.
    return out as ResolvedEdge
  }
  if (kind === 'omit') return { kind: 'omit' }
  const a_cell: Vec3 = [ax, ay, az]
  const b_cell: Vec3 = [bx, by, bz]
  if (kind === 'ghost') return { kind, a_cell, b_cell, ghost: true }
  return { kind, a_cell, b_cell, ghost: false }
}

const EMPTY_IMAGE_TABLE: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

/**
 * Build the sparse, deduplicated `ImageInstanceTable` of ghost instances the
 * `ghost-images` policy needs. For every base bond in every replica cell, when
 * endpoint B's image (`cell + jimage`) falls outside the supercell, a ghost of
 * base site B at that absolute image is required. Ghosts are deduplicated by
 * (base_site, absolute image). Non-ghost policies produce an empty table.
 *
 * Dedup keys are NUMERIC (no per-probe string allocation — the string form
 * costs one allocation per bond × cell probe, ~2.7M for 100k bonds × 27 cells):
 * `key = base_site · span + offset(tx,ty,tz)`, a bijection by construction.
 * Component ranges are guaranteed: jimages are Int8 (`j ∈ [-128, 127]`) and
 * cells lie in `[0, dims)`, so `t + 128 ∈ [0, dims + 255)`. The only guard is on
 * `base_site` staying below `MAX_SAFE_INTEGER / span` (≈5·10⁸ sites for 3×3×3
 * dims — unreachable in practice); violations throw rather than risk collision.
 */
export function build_image_instance_table(
  bond_graph: BaseBondGraph,
  dims: Cell,
  policy: BoundaryPolicy,
): ImageInstanceTable {
  if (policy !== 'ghost-images') return EMPTY_IMAGE_TABLE
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const nz = dims[2] > 0 ? dims[2] : 1
  // Absolute image component t = i + j with i ∈ [0,n), j ∈ [-128,127],
  // so t + 128 ∈ [0, n + 255). One span per axis keeps the key collision-free.
  const sx = nx + 255
  const sy = ny + 255
  const sz = nz + 255
  const span = sx * sy * sz
  const site_cap = Math.floor(Number.MAX_SAFE_INTEGER / span)
  const bond_count = bond_graph.pairs.length / 2
  const seen = new Set<number>()
  const sites: number[] = []
  const images: number[] = []
  for (let bi = 0; bi < bond_count; bi++) {
    const b = bond_graph.pairs[bi * 2 + 1]
    if (b >= site_cap) {
      throw new Error(
        `build_image_instance_table: base site ${b} exceeds the numeric dedup ` +
          `key capacity (${site_cap}) for dims [${nx}, ${ny}, ${nz}]`,
      )
    }
    const jx = bond_graph.jimages[bi * 3]
    const jy = bond_graph.jimages[bi * 3 + 1]
    const jz = bond_graph.jimages[bi * 3 + 2]
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const tx = ix + jx
          const ty = iy + jy
          const tz = iz + jz
          const outside = tx < 0 || tx >= nx || ty < 0 || ty >= ny || tz < 0 || tz >= nz
          if (!outside) continue
          const key = b * span + ((tz + 128) * sy + (ty + 128)) * sx + (tx + 128)
          if (seen.has(key)) continue
          seen.add(key)
          sites.push(b)
          images.push(tx, ty, tz)
        }
      }
    }
  }
  return {
    count: sites.length,
    base_sites: Uint32Array.from(sites),
    jimages: Int8Array.from(images),
  }
}

/** True modulo: normalizes `v` into `[0, n)` for any sign of `v`. */
function wrap_component(v: number, n: number): number {
  return ((v % n) + n) % n
}

/**
 * Resolve a pick to its logical/physical site id.
 *
 * - `miss`                     → -1
 * - `bond`                     → the BOND GRAPH index (`base_site` carries the
 *                                bond index for `kind: 'bond'`), returned
 *                                unchanged. Bond picks NEVER consult
 *                                `physical_site_map` — that map is indexed by
 *                                atoms, not bonds.
 * - atom, `visual-shared-base` → the base site (every visual replica, including
 *                                ghosts, folds back to the one base atom —
 *                                design §7.2)
 * - atom, `physical-distinct-sites`
 *                              → the unique physical site via
 *                                `physical_site_map`, indexed atom-major by
 *                                `base_site + base_count · cell_index`. A ghost
 *                                pick's cell lies OUTSIDE `[0, dims)`; it is
 *                                first wrapped into the supercell with a true
 *                                modulo, because the ghost visually represents
 *                                the periodic image of that wrapped replica's
 *                                physical atom (picking stays unique per §9.4).
 *                                Non-ghost cells must already be normalized:
 *                                `encode_cell_index` returns -1 for off-grid
 *                                cells and the resolver then falls back to the
 *                                base site (defensive; never aliases another
 *                                replica). Falls back to the base site if no
 *                                map is present (invalid per
 *                                `assert_render_packet`, tolerated here).
 */
export function logical_site_for_pick(
  pick: ReplicaPickResult,
  replicas: ReplicaLayout,
): number {
  if (pick.kind === 'miss') return -1
  if (pick.kind === 'bond') return pick.base_site
  if (replicas.semantics === 'visual-shared-base' || !replicas.physical_site_map) {
    return pick.base_site
  }
  const nx = replicas.dims[0] > 0 ? replicas.dims[0] : 1
  const ny = replicas.dims[1] > 0 ? replicas.dims[1] : 1
  const nz = replicas.dims[2] > 0 ? replicas.dims[2] : 1
  const base_count = replicas.physical_site_map.length / (nx * ny * nz)
  const cell: Cell = pick.ghost
    ? [
      wrap_component(pick.cell[0], nx),
      wrap_component(pick.cell[1], ny),
      wrap_component(pick.cell[2], nz),
    ]
    : pick.cell
  const cell_index = encode_cell_index(cell, replicas.dims)
  if (cell_index < 0) return pick.base_site
  const instance_index = pick.base_site + base_count * cell_index
  if (instance_index < 0 || instance_index >= replicas.physical_site_map.length) {
    return pick.base_site
  }
  return replicas.physical_site_map[instance_index]
}
