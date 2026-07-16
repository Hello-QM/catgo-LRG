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
 * Decode an atom-major `instance_index` into its base atom and replica cell.
 * The inverse of `instance_index = atom_index + base_count · cell_index`.
 */
export function decode_replica_instance(
  instance_index: number,
  base_count: number,
  dims: Cell,
): ReplicaInstance {
  const bc = base_count > 0 ? base_count : 1
  const atom_index = instance_index % bc
  const cell_index = (instance_index - atom_index) / bc
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const ix = cell_index % nx
  const iy = Math.floor(cell_index / nx) % ny
  const iz = Math.floor(cell_index / (nx * ny))
  return { atom_index, cell: [ix, iy, iz], cell_index }
}

/** Encode a replica cell into its atom-major cell index (x-fastest, then y,z). */
export function encode_cell_index(cell: Cell, dims: Cell): number {
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
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

/** True when a cell lies inside the supercell `[0,nx) × [0,ny) × [0,nz)`. */
function cell_inside(cell: Cell, dims: Cell): boolean {
  return (
    cell[0] >= 0 && cell[0] < dims[0] &&
    cell[1] >= 0 && cell[1] < dims[1] &&
    cell[2] >= 0 && cell[2] < dims[2]
  )
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
 */
export function resolve_periodic_edge(
  bond: PeriodicBond,
  cell: Cell,
  dims: Cell,
  policy: BoundaryPolicy,
): ResolvedEdge {
  const a_cell: Vec3 = [cell[0], cell[1], cell[2]]
  const b_cell: Vec3 = [
    cell[0] + bond.jimage[0],
    cell[1] + bond.jimage[1],
    cell[2] + bond.jimage[2],
  ]
  if (cell_inside(b_cell, dims)) {
    return { kind: 'complete', a_cell, b_cell, ghost: false }
  }
  switch (policy) {
    case 'stub':
      return { kind: 'stub', a_cell, b_cell, ghost: false }
    case 'hide':
      return { kind: 'omit' }
    case 'ghost-images':
      return { kind: 'ghost', a_cell, b_cell, ghost: true }
  }
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
  const bond_count = bond_graph.pairs.length / 2
  const seen = new Set<string>()
  const sites: number[] = []
  const images: number[] = []
  for (let bi = 0; bi < bond_count; bi++) {
    const b = bond_graph.pairs[bi * 2 + 1]
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
          const key = `${b}|${tx},${ty},${tz}`
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

/**
 * Resolve a pick to its logical/physical site id.
 *
 * - `miss`                     → -1
 * - `visual-shared-base`       → the base site (every visual replica, including
 *                                ghosts, folds back to the one base atom)
 * - `physical-distinct-sites`  → the unique physical site via `physical_site_map`,
 *                                indexed atom-major by
 *                                `base_site + base_count · cell_index`. Falls
 *                                back to the base site if no map is present.
 */
export function logical_site_for_pick(
  pick: ReplicaPickResult,
  replicas: ReplicaLayout,
): number {
  if (pick.kind === 'miss') return -1
  if (replicas.semantics === 'visual-shared-base' || !replicas.physical_site_map) {
    return pick.base_site
  }
  const [nx, ny, nz] = replicas.dims
  const cells = (nx > 0 ? nx : 1) * (ny > 0 ? ny : 1) * (nz > 0 ? nz : 1)
  const base_count = replicas.physical_site_map.length / cells
  const cell_index = encode_cell_index(pick.cell, replicas.dims)
  const instance_index = pick.base_site + base_count * cell_index
  if (instance_index < 0 || instance_index >= replicas.physical_site_map.length) {
    return pick.base_site
  }
  return replicas.physical_site_map[instance_index]
}
