/**
 * Render-only fast path for a freshly materialized, axis-aligned true
 * supercell.
 *
 * The scientific output remains the full physical structure for editing,
 * history, and export.  While its replication provenance is intact, WebGPU can
 * render the much smaller home cell with GPU instancing and use the reordered
 * physical-site map to turn a replica pick back into the unique output site.
 *
 * General integer transforms (shears, rotations, negative diagonals) keep the
 * fully materialized render path.  ReplicaLayout currently represents positive
 * axis-aligned dimensions, so pretending a general transform fits that contract
 * would draw the wrong geometry.
 */

import type { Matrix3x3, Vec3 } from '$lib/math'
import type {
  PymatgenStructure,
  Site,
} from '$lib/structure'
import type {
  SupercellExecution,
  SupercellProvenance,
} from '$lib/structure/supercell-operation'
import {
  cartesian_to_fractional,
  matrix_to_params,
} from '$lib/structure/lattice-ops'
import type {
  BaseBondGraph,
  ImageInstanceTable,
} from '$lib/structure/scene/render-packet'
import type { PeriodicDecorationSource } from '$lib/structure/scene/periodic-decoration-snapshot'

export type PhysicalSupercellRenderSource = {
  base_structure: PymatgenStructure
  dims: readonly [number, number, number]
  /** Atom-major, x-fastest map expected by ReplicaLayout. */
  physical_site_map: Uint32Array
}

export type PhysicalPeriodicDecoration = {
  /** Materialized ordinary graph collapsed into the reconstructed base cell. */
  graph: BaseBondGraph
  /** Ordinary boundary atoms expressed as base-site + absolute replica cell. */
  atom_images: ImageInstanceTable
  /** Same final ordinary boundary ownership used by bond decorators. */
  images: ImageInstanceTable
}

function decode_x_fast_cell(
  cell_index: number,
  dims: readonly [number, number, number],
): readonly [number, number, number] {
  const x = cell_index % dims[0]
  const y = Math.floor(cell_index / dims[0]) % dims[1]
  const z = Math.floor(cell_index / (dims[0] * dims[1]))
  return [x, y, z]
}

function valid_image_table(
  table: ImageInstanceTable,
  atom_count: number,
): boolean {
  if (
    !Number.isInteger(table.count) ||
    table.count < 0 ||
    table.base_sites.length !== table.count ||
    table.jimages.length !== table.count * 3
  ) return false
  for (let idx = 0; idx < table.count; idx++) {
    if (table.base_sites[idx] >= atom_count) return false
  }
  return true
}

/**
 * Re-express the final ordinary boundary snapshot of a materialized positive
 * diagonal supercell in the smaller base-cell packet used by WebGPU.
 *
 * `physical_site_map[cell · base_count + base_site] = physical_site`.
 * Therefore an ordinary image `(physical_site, q)` maps to
 * `(base_site, cell + q · dims)`. Bond translations use the same change of
 * coordinates: `jbase = cellB + jout · dims - cellA`.
 *
 * The conversion changes only representation. Cartesian atom centers and bond
 * endpoints remain byte-for-byte equivalent up to Float32 rounding.
 */
export function map_physical_periodic_decoration_to_base(
  source: PeriodicDecorationSource,
  physical_site_map: Uint32Array,
  dims: readonly [number, number, number],
  base_count: number,
): PhysicalPeriodicDecoration | null {
  if (
    !Number.isInteger(base_count) ||
    base_count < 1 ||
    dims.some((value) => !Number.isInteger(value) || value < 1)
  ) return null

  const cell_count = dims[0] * dims[1] * dims[2]
  const physical_count = base_count * cell_count
  if (
    physical_site_map.length !== physical_count ||
    source.atom_count !== physical_count ||
    !valid_image_table(source.atom_images, physical_count) ||
    !valid_image_table(source.images, physical_count)
  ) return null

  const bond_count = source.graph.pairs.length / 2
  if (
    !Number.isInteger(bond_count) ||
    source.graph.jimages.length !== bond_count * 3 ||
    source.graph.kinds.length !== bond_count ||
    source.graph.strengths.length !== bond_count
  ) return null

  const MISSING = 0xffffffff
  const physical_to_base = new Uint32Array(physical_count)
  const physical_to_cell = new Uint32Array(physical_count)
  physical_to_base.fill(MISSING)
  physical_to_cell.fill(MISSING)
  for (let cell_index = 0; cell_index < cell_count; cell_index++) {
    for (let base_site = 0; base_site < base_count; base_site++) {
      const physical_site =
        physical_site_map[cell_index * base_count + base_site]
      if (
        physical_site >= physical_count ||
        physical_to_base[physical_site] !== MISSING
      ) return null
      physical_to_base[physical_site] = base_site
      physical_to_cell[physical_site] = cell_index
    }
  }

  function map_images(table: ImageInstanceTable): ImageInstanceTable | null {
    const base_sites: number[] = []
    const jimages: number[] = []
    const seen = new Set<string>()
    for (let idx = 0; idx < table.count; idx++) {
      const physical_site = table.base_sites[idx]
      const base_site = physical_to_base[physical_site]
      const cell_index = physical_to_cell[physical_site]
      if (base_site === MISSING || cell_index === MISSING) return null
      const cell = decode_x_fast_cell(cell_index, dims)
      const offset = idx * 3
      const x = cell[0] + table.jimages[offset] * dims[0]
      const y = cell[1] + table.jimages[offset + 1] * dims[1]
      const z = cell[2] + table.jimages[offset + 2] * dims[2]
      if (
        x < -128 || x > 127 ||
        y < -128 || y > 127 ||
        z < -128 || z > 127
      ) return null
      const key = `${base_site}|${x},${y},${z}`
      if (seen.has(key)) continue
      seen.add(key)
      base_sites.push(base_site)
      jimages.push(x, y, z)
    }
    return {
      count: base_sites.length,
      base_sites: Uint32Array.from(base_sites),
      jimages: Int8Array.from(jimages),
    }
  }

  const atom_images = map_images(source.atom_images)
  const images = map_images(source.images)
  if (!atom_images || !images) return null

  const pairs: number[] = []
  const jimages: number[] = []
  const kinds: number[] = []
  const strengths: number[] = []
  const seen_bonds = new Set<string>()
  for (let bond_idx = 0; bond_idx < bond_count; bond_idx++) {
    const physical_a = source.graph.pairs[bond_idx * 2]
    const physical_b = source.graph.pairs[bond_idx * 2 + 1]
    if (physical_a >= physical_count || physical_b >= physical_count) {
      return null
    }
    let a = physical_to_base[physical_a]
    let b = physical_to_base[physical_b]
    const cell_a = decode_x_fast_cell(physical_to_cell[physical_a], dims)
    const cell_b = decode_x_fast_cell(physical_to_cell[physical_b], dims)
    const offset = bond_idx * 3
    let x = cell_b[0] + source.graph.jimages[offset] * dims[0] - cell_a[0]
    let y = cell_b[1] + source.graph.jimages[offset + 1] * dims[1] - cell_a[1]
    let z = cell_b[2] + source.graph.jimages[offset + 2] * dims[2] - cell_a[2]

    // Translation-equivalent physical replicas collapse to one directed base
    // edge. Canonicalize the reverse representation as well; self-image bonds
    // choose the first non-zero translation component positive.
    const reverse = a > b || (
      a === b &&
      (x < 0 || (x === 0 && (y < 0 || (y === 0 && z < 0))))
    )
    if (reverse) {
      const previous_a = a
      a = b
      b = previous_a
      x = -x
      y = -y
      z = -z
    }
    if (
      x < -128 || x > 127 ||
      y < -128 || y > 127 ||
      z < -128 || z > 127
    ) return null
    const key = `${a}|${b}|${x},${y},${z}`
    if (seen_bonds.has(key)) continue
    seen_bonds.add(key)
    pairs.push(a, b)
    jimages.push(x, y, z)
    kinds.push(source.graph.kinds[bond_idx])
    strengths.push(source.graph.strengths[bond_idx])
  }

  return {
    graph: {
      version: source.graph.version,
      pairs: Uint32Array.from(pairs),
      jimages: Int8Array.from(jimages),
      kinds: Uint8Array.from(kinds),
      strengths: Float32Array.from(strengths),
    },
    atom_images,
    images,
  }
}

function positive_diagonal_dims(
  provenance: SupercellProvenance,
): readonly [number, number, number] | null {
  const m = provenance.matrix
  if (
    m[0][1] !== 0 || m[0][2] !== 0 ||
    m[1][0] !== 0 || m[1][2] !== 0 ||
    m[2][0] !== 0 || m[2][1] !== 0
  ) return null
  const dims = [m[0][0], m[1][1], m[2][2]] as const
  if (dims.some((value) => !Number.isInteger(value) || value < 1)) return null
  return dims
}

function determinant(matrix: Matrix3x3): number {
  const [a, b, c] = matrix
  return a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
}

function x_fast_cell_index(
  cell: readonly [number, number, number],
  dims: readonly [number, number, number],
): number {
  return cell[0] + dims[0] * (cell[1] + dims[1] * cell[2])
}

/**
 * Build the base-cell packet source for a completed true supercell.
 *
 * Returns null when the provenance cannot be represented by the current
 * positive-diagonal ReplicaLayout.  The caller then renders the materialized
 * structure exactly as before.
 */
export function build_physical_supercell_render_source(
  execution: SupercellExecution,
): PhysicalSupercellRenderSource | null {
  const { structure, provenance } = execution
  const dims = positive_diagonal_dims(provenance)
  if (!dims) return null

  const base_count = provenance.source_atom_count
  const cell_count = dims[0] * dims[1] * dims[2]
  if (
    base_count < 1 ||
    provenance.cell_count !== cell_count ||
    provenance.cell_order.length !== cell_count ||
    provenance.physical_site_map.length !== base_count * cell_count ||
    structure.sites.length !== base_count * cell_count
  ) return null

  // Provenance enumeration is deterministic but z-fastest, whereas every GPU
  // replica renderer decodes x-fastest.  Reorder once at publication so
  // picking replica (ix,iy,iz) returns the correct physical output site.
  const physical_site_map = new Uint32Array(base_count * cell_count)
  const seen = new Uint8Array(cell_count)
  let home_provenance_cell = -1
  for (let source_cell = 0; source_cell < cell_count; source_cell++) {
    const raw = provenance.cell_order[source_cell]
    const cell = [raw[0], raw[1], raw[2]] as const
    if (
      !Number.isInteger(cell[0]) || !Number.isInteger(cell[1]) ||
      !Number.isInteger(cell[2]) ||
      cell[0] < 0 || cell[0] >= dims[0] ||
      cell[1] < 0 || cell[1] >= dims[1] ||
      cell[2] < 0 || cell[2] >= dims[2]
    ) return null
    const target_cell = x_fast_cell_index(cell, dims)
    if (seen[target_cell]) return null
    seen[target_cell] = 1
    if (target_cell === 0) home_provenance_cell = source_cell
    for (let base_site = 0; base_site < base_count; base_site++) {
      const physical_site =
        provenance.physical_site_map[source_cell * base_count + base_site]
      if (physical_site >= structure.sites.length) return null
      physical_site_map[target_cell * base_count + base_site] = physical_site
    }
  }
  if (home_provenance_cell < 0) return null

  // execution.structure is already reoriented (when requested). Dividing the
  // output lattice rows by the positive diagonal factors recovers the equally
  // reoriented base lattice, so instancing reproduces the output coordinates.
  const output_matrix = structure.lattice.matrix
  const base_matrix: Matrix3x3 = [
    output_matrix[0].map((value) => value / dims[0]) as Vec3,
    output_matrix[1].map((value) => value / dims[1]) as Vec3,
    output_matrix[2].map((value) => value / dims[2]) as Vec3,
  ]
  const params = matrix_to_params(base_matrix as [Vec3, Vec3, Vec3])
  const base_sites: Site[] = new Array(base_count)
  for (let base_site = 0; base_site < base_count; base_site++) {
    const physical_site =
      provenance.physical_site_map[home_provenance_cell * base_count + base_site]
    const site = structure.sites[physical_site]
    base_sites[base_site] = {
      ...site,
      abc: cartesian_to_fractional(site.xyz, base_matrix as [Vec3, Vec3, Vec3]),
    }
  }

  const base_structure: PymatgenStructure = {
    ...structure,
    lattice: {
      ...structure.lattice,
      matrix: base_matrix,
      ...params,
      volume: Math.abs(determinant(base_matrix)),
    },
    sites: base_sites,
    charge: structure.charge != null ? structure.charge / cell_count : structure.charge,
  }

  return {
    base_structure,
    dims,
    physical_site_map,
  }
}

// Structure.svelte receives the assigned value through a deep reactive proxy.
// Registering both the executor's plain object and the live assigned object lets
// identity lookup survive either Svelte representation without serializing
// render-only provenance into exported scientific data.
const sources = new WeakMap<object, PhysicalSupercellRenderSource>()

export function register_physical_supercell_render_source(
  structure: object,
  source: PhysicalSupercellRenderSource,
): void {
  sources.set(structure, source)
}

export function physical_supercell_render_source_for(
  structure: object | null | undefined,
): PhysicalSupercellRenderSource | null {
  return structure ? sources.get(structure) ?? null : null
}
