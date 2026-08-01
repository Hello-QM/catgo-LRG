/**
 * Pure, renderer-neutral snapshot of the ordinary StructureScene periodic
 * decoration pass.
 *
 * The ordinary renderer treats every non-home image atom as an anchor and
 * decorates it with every BondManager slot incident on the corresponding base
 * site. This module preserves that exact ownership model in typed data so a
 * second renderer can consume the same atom centers and bond endpoints instead
 * of independently deriving graph-boundary ghosts.
 */

import type {
  BaseBondGraph,
  BoundaryPolicy,
  FrameGeometry,
  ImageInstanceTable,
} from './render-packet'

export type DecorationCell = readonly [number, number, number]

export const BOUNDARY_BOND_MODE = {
  FULL: 0,
  STUB: 1,
  HIDDEN: 2,
} as const

export type BoundaryBondMode =
  (typeof BOUNDARY_BOND_MODE)[keyof typeof BOUNDARY_BOND_MODE]

export const BOUNDARY_BOND_ANCHOR = {
  A: 0,
  B: 1,
} as const

export type BoundaryBondAnchor =
  (typeof BOUNDARY_BOND_ANCHOR)[keyof typeof BOUNDARY_BOND_ANCHOR]

/**
 * One row per `(image atom × incident base bond)`, in image-table order and
 * then base-graph slot order. This is the same stable order produced by
 * `build_image_atom_layout` and consumed by the ordinary bond decorator.
 *
 * Hidden rows are retained (rather than dropped) so instance/picker indexing
 * can remain aligned with the ordinary renderer. Their draw segment is
 * collapsed to the anchor center.
 */
export type BoundaryBondEndpointLayout = {
  count: number
  visible_count: number
  /** BaseBondGraph slot for each row. */
  bond_indices: Uint32Array
  /** ImageInstanceTable row which owns/decorates this bond. */
  image_indices: Uint32Array
  /** `BOUNDARY_BOND_ANCHOR.A` or `.B`. Self-image edges choose A. */
  anchor_sides: Uint8Array
  /** `BOUNDARY_BOND_MODE.FULL`, `.STUB`, or `.HIDDEN`. */
  modes: Uint8Array
  /** Absolute replica cells for the graph's A endpoints, 3 × count. */
  a_cells: Int16Array
  /** Absolute replica cells for the graph's B endpoints, 3 × count. */
  b_cells: Int16Array
  /** Full underlying A endpoint centers, 3 × count. */
  a_positions: Float32Array
  /** Full underlying B endpoint centers, 3 × count. */
  b_positions: Float32Array
  /**
   * Visible segment endpoints, 3 × count each.
   *
   * FULL: A → B.
   * STUB: anchor → anchor +/− 0.5 × stub_scale × (B − A).
   * HIDDEN: anchor → anchor (zero length).
   */
  draw_starts: Float32Array
  draw_ends: Float32Array
}

export type PeriodicDecorationSnapshot = {
  /** Authoritative final ordinary-mode BondManager graph. */
  graph: BaseBondGraph
  /** Authoritative current base positions and row-major lattice. */
  frame: FrameGeometry
  /** Real replica cells occupy `[0, dims)` on each axis. */
  dims: readonly [number, number, number]
  policy: BoundaryPolicy
  stub_scale: number
  /** Ordinary boundary image selection, already expanded to absolute cells. */
  images: ImageInstanceTable
  /** Cartesian center per image-table row, 3 × images.count. */
  image_centers: Float32Array
  /** Ordinary image-anchored bond decoration layout. */
  boundary_segments: BoundaryBondEndpointLayout
}

/** Stable ordinary-mode ownership that can cross a component boundary before
 *  the consuming renderer resolves its own transformed frame geometry. */
export type PeriodicDecorationSource = Pick<
  PeriodicDecorationSnapshot,
  'graph' | 'images'
> & {
  /**
   * Parent-issued identity token for the structure whose site-index space owns
   * `graph`. A numeric token stays stable across Svelte raw/proxy boundaries.
   *
   * A structure replacement can leave the previous ordinary BondManager
   * publication visible for one reactive turn. Consumers must require token
   * equality with their packet owner before attaching this graph; an index
   * bounds check alone cannot distinguish two different N-site structures.
   */
  owner_id: number
  /** Site count of the owner when the graph publication was committed. */
  atom_count: number
  /**
   * Exact non-home atom instances appended to the ordinary displayed
   * structure. The ordinary producer aligns `images` to this final set so
   * every visible boundary atom has the same bond-decorator ownership in both
   * render backends.
   */
  atom_images: ImageInstanceTable
}

const EMPTY_DISPLAYED_IMAGE_TABLE: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

type DisplayedImageSite = {
  abc: ArrayLike<number>
}

/**
 * Recover the exact sparse atom-image table rendered by ordinary mode from
 * its appended `displayed_structure` representation.
 *
 * `num_original_sites` splits the base prefix from appended image rows and
 * `image_to_original_map` supplies each appended row's base-site owner. The
 * integer image cell is the rounded fractional-coordinate delta between the
 * appended site and that owner. PBC generation may nudge coordinates by a
 * tiny epsilon near boundaries, hence rounding rather than exact subtraction.
 *
 * Invalid/incomplete bridge metadata returns the stable empty table. This is
 * important during reactive structure replacement, where the structure and
 * its mapping props can briefly belong to adjacent revisions.
 */
export function displayed_image_atoms_to_instance_table(
  sites: ReadonlyArray<DisplayedImageSite>,
  num_original_sites: number | undefined,
  image_to_original_map: ArrayLike<number> | undefined,
): ImageInstanceTable {
  if (
    num_original_sites === undefined ||
    !Number.isInteger(num_original_sites) ||
    num_original_sites < 0 ||
    num_original_sites > sites.length
  ) return EMPTY_DISPLAYED_IMAGE_TABLE

  const image_count = sites.length - num_original_sites
  if (image_count === 0) return EMPTY_DISPLAYED_IMAGE_TABLE
  if (!image_to_original_map || image_to_original_map.length < image_count) {
    return EMPTY_DISPLAYED_IMAGE_TABLE
  }

  const base_sites: number[] = []
  const jimages: number[] = []
  for (let image_idx = 0; image_idx < image_count; image_idx++) {
    const base_site = image_to_original_map[image_idx]
    if (
      !Number.isInteger(base_site) ||
      base_site < 0 ||
      base_site >= num_original_sites
    ) continue

    const base_abc = sites[base_site]?.abc
    const image_abc = sites[num_original_sites + image_idx]?.abc
    if (!base_abc || !image_abc || base_abc.length < 3 || image_abc.length < 3) {
      continue
    }
    const jx = Math.round(image_abc[0] - base_abc[0])
    const jy = Math.round(image_abc[1] - base_abc[1])
    const jz = Math.round(image_abc[2] - base_abc[2])
    if (
      !Number.isFinite(jx) || !Number.isFinite(jy) || !Number.isFinite(jz) ||
      jx < -128 || jx > 127 ||
      jy < -128 || jy > 127 ||
      jz < -128 || jz > 127
    ) continue
    if ((jx | jy | jz) === 0) continue
    base_sites.push(base_site)
    jimages.push(jx, jy, jz)
  }

  if (base_sites.length === 0) return EMPTY_DISPLAYED_IMAGE_TABLE
  return {
    count: base_sites.length,
    base_sites: Uint32Array.from(base_sites),
    jimages: Int8Array.from(jimages),
  }
}

export type BoundaryBondLayoutOptions = {
  dims?: DecorationCell
  policy?: BoundaryPolicy
  stub_scale?: number
}

export type PeriodicDecorationSnapshotInput = BoundaryBondLayoutOptions & {
  graph: BaseBondGraph
  frame: FrameGeometry
  images: ImageInstanceTable
}

function normalized_dims(
  dims: DecorationCell | undefined,
): readonly [number, number, number] {
  const resolved = dims ?? [1, 1, 1]
  for (let axis = 0; axis < 3; axis++) {
    const value = resolved[axis]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `PeriodicDecoration: dims must be integers ≥ 1, got ` +
          `[${resolved[0]}, ${resolved[1]}, ${resolved[2]}]`,
      )
    }
  }
  return [resolved[0], resolved[1], resolved[2]]
}

/**
 * Expand an ordinary 1×1×1 outside-image table onto the outer surface of a
 * visual replica grid.
 *
 * Ordinary mode publishes absolute image cells around one real cell:
 * non-zero axes identify an outside face/edge/corner while zero axes are
 * transverse. For an N-cell visual replica, positive outside coordinates move
 * to the far boundary (`+1 → N`), negative coordinates remain on the near
 * boundary, and every transverse zero spans all real cells. This is the same
 * surface expansion used by `image_sites_to_instance_table`, applied to the
 * already-authoritative ordinary atom/decorator stream instead of regenerating
 * boundary ownership from structure coordinates.
 */
export function expand_ordinary_image_table(
  images: ImageInstanceTable,
  dims: DecorationCell,
): ImageInstanceTable {
  const [nx, ny, nz] = normalized_dims(dims)
  if (nx === 1 && ny === 1 && nz === 1) return images
  if (images.count === 0) return images

  const base_sites: number[] = []
  const jimages: number[] = []
  const seen = new Set<string>()
  for (let image_idx = 0; image_idx < images.count; image_idx++) {
    const site = images.base_sites[image_idx]
    const offset = image_idx * 3
    const rx = images.jimages[offset]
    const ry = images.jimages[offset + 1]
    const rz = images.jimages[offset + 2]
    const x0 = rx === 0 ? 0 : rx > 0 ? nx - 1 + rx : rx
    const x1 = rx === 0 ? nx - 1 : x0
    const y0 = ry === 0 ? 0 : ry > 0 ? ny - 1 + ry : ry
    const y1 = ry === 0 ? ny - 1 : y0
    const z0 = rz === 0 ? 0 : rz > 0 ? nz - 1 + rz : rz
    const z1 = rz === 0 ? nz - 1 : z0
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (
            x < -128 || x > 127 ||
            y < -128 || y > 127 ||
            z < -128 || z > 127
          ) {
            throw new Error(
              `PeriodicDecoration: expanded jimage [${x}, ${y}, ${z}] ` +
                `exceeds Int8 storage range [-128, 127]`,
            )
          }
          const key = `${site}|${x},${y},${z}`
          if (seen.has(key)) continue
          seen.add(key)
          base_sites.push(site)
          jimages.push(x, y, z)
        }
      }
    }
  }
  return {
    count: base_sites.length,
    base_sites: Uint32Array.from(base_sites),
    jimages: Int8Array.from(jimages),
  }
}

function validate_inputs(
  graph: BaseBondGraph,
  images: ImageInstanceTable,
  positions: ArrayLike<number>,
  lattice: ArrayLike<number>,
): number {
  if (positions.length % 3 !== 0) {
    throw new Error(
      `PeriodicDecoration: positions.length (${positions.length}) must be divisible by 3`,
    )
  }
  if (lattice.length !== 9) {
    throw new Error(
      `PeriodicDecoration: lattice.length (${lattice.length}) must be 9`,
    )
  }
  if (!Number.isInteger(images.count) || images.count < 0) {
    throw new Error(
      `PeriodicDecoration: image count must be a non-negative integer, got ${images.count}`,
    )
  }
  if (images.base_sites.length !== images.count) {
    throw new Error(
      `PeriodicDecoration: image base_sites.length (${images.base_sites.length}) ` +
        `!== count (${images.count})`,
    )
  }
  if (images.jimages.length !== images.count * 3) {
    throw new Error(
      `PeriodicDecoration: image jimages.length (${images.jimages.length}) ` +
        `!== 3 × count (${images.count * 3})`,
    )
  }
  if (graph.pairs.length % 2 !== 0) {
    throw new Error(
      `PeriodicDecoration: graph pairs.length (${graph.pairs.length}) must be even`,
    )
  }
  const bond_count = graph.pairs.length / 2
  if (graph.jimages.length !== bond_count * 3) {
    throw new Error(
      `PeriodicDecoration: graph jimages.length (${graph.jimages.length}) ` +
        `!== 3 × bond count (${bond_count * 3})`,
    )
  }
  if (graph.kinds.length !== bond_count || graph.strengths.length !== bond_count) {
    throw new Error(`PeriodicDecoration: graph attribute lengths do not match bond count`)
  }

  const atom_count = positions.length / 3
  for (let idx = 0; idx < graph.pairs.length; idx++) {
    const site = graph.pairs[idx]
    if (site >= atom_count) {
      throw new Error(
        `PeriodicDecoration: graph site ${site} is outside atom count ${atom_count}`,
      )
    }
  }
  for (let idx = 0; idx < images.count; idx++) {
    const site = images.base_sites[idx]
    if (site >= atom_count) {
      throw new Error(
        `PeriodicDecoration: image site ${site} is outside atom count ${atom_count}`,
      )
    }
  }
  return atom_count
}

function write_center(
  out: Float32Array,
  out_offset: number,
  site: number,
  cx: number,
  cy: number,
  cz: number,
  positions: ArrayLike<number>,
  lattice: ArrayLike<number>,
): void {
  const site_offset = site * 3
  out[out_offset] = positions[site_offset] +
    cx * lattice[0] + cy * lattice[3] + cz * lattice[6]
  out[out_offset + 1] = positions[site_offset + 1] +
    cx * lattice[1] + cy * lattice[4] + cz * lattice[7]
  out[out_offset + 2] = positions[site_offset + 2] +
    cx * lattice[2] + cy * lattice[5] + cz * lattice[8]
}

/** Resolve every ordinary image atom center against the current frame lattice. */
export function build_periodic_image_centers(
  images: ImageInstanceTable,
  positions: ArrayLike<number>,
  lattice: ArrayLike<number>,
): Float32Array {
  validate_inputs(
    {
      version: 0,
      pairs: new Uint32Array(0),
      jimages: new Int8Array(0),
      kinds: new Uint8Array(0),
      strengths: new Float32Array(0),
    },
    images,
    positions,
    lattice,
  )
  const centers = new Float32Array(images.count * 3)
  for (let image_idx = 0; image_idx < images.count; image_idx++) {
    const offset = image_idx * 3
    write_center(
      centers,
      offset,
      images.base_sites[image_idx],
      images.jimages[offset],
      images.jimages[offset + 1],
      images.jimages[offset + 2],
      positions,
      lattice,
    )
  }
  return centers
}

function image_key(site: number, x: number, y: number, z: number): string {
  return `${site}|${x},${y},${z}`
}

/**
 * Reproduce the ordinary image-atom bond decorator as endpoint data.
 *
 * Every image atom anchors every incident graph slot. A partner is considered
 * drawn when it is either a real replica inside `[0,dims)` or another row in
 * `images`. Missing partners collapse under `hide`; otherwise only the anchor
 * side is emitted as a stub. `ghost-images` uses the same missing-partner stub
 * behavior as ordinary mode because the supplied image table, not the graph,
 * is authoritative for which ghosts exist.
 */
export function build_boundary_bond_endpoint_layout(
  graph: BaseBondGraph,
  images: ImageInstanceTable,
  positions: ArrayLike<number>,
  lattice: ArrayLike<number>,
  options: BoundaryBondLayoutOptions = {},
): BoundaryBondEndpointLayout {
  const atom_count = validate_inputs(graph, images, positions, lattice)
  const dims = normalized_dims(options.dims)
  const policy = options.policy ?? `ghost-images`
  const stub_scale = options.stub_scale ?? 0.5
  if (!Number.isFinite(stub_scale) || stub_scale < 0) {
    throw new Error(
      `PeriodicDecoration: stub_scale must be finite and non-negative, got ${stub_scale}`,
    )
  }

  const bond_count = graph.pairs.length / 2
  const incident_counts = new Uint32Array(atom_count)
  for (let slot = 0; slot < bond_count; slot++) {
    const a = graph.pairs[slot * 2]
    const b = graph.pairs[slot * 2 + 1]
    incident_counts[a]++
    if (a !== b) incident_counts[b]++
  }

  const incident_offsets = new Uint32Array(atom_count + 1)
  for (let site = 0; site < atom_count; site++) {
    incident_offsets[site + 1] = incident_offsets[site] + incident_counts[site]
  }
  const incident_slots = new Uint32Array(incident_offsets[atom_count])
  const incident_cursors = incident_offsets.slice(0, atom_count)
  for (let slot = 0; slot < bond_count; slot++) {
    const a = graph.pairs[slot * 2]
    const b = graph.pairs[slot * 2 + 1]
    incident_slots[incident_cursors[a]++] = slot
    if (a !== b) incident_slots[incident_cursors[b]++] = slot
  }

  let count = 0
  for (let image_idx = 0; image_idx < images.count; image_idx++) {
    const site = images.base_sites[image_idx]
    count += incident_offsets[site + 1] - incident_offsets[site]
  }

  const bond_indices = new Uint32Array(count)
  const image_indices = new Uint32Array(count)
  const anchor_sides = new Uint8Array(count)
  const modes = new Uint8Array(count)
  const a_cells = new Int16Array(count * 3)
  const b_cells = new Int16Array(count * 3)
  const a_positions = new Float32Array(count * 3)
  const b_positions = new Float32Array(count * 3)
  const draw_starts = new Float32Array(count * 3)
  const draw_ends = new Float32Array(count * 3)

  const drawn_images = new Set<string>()
  for (let image_idx = 0; image_idx < images.count; image_idx++) {
    const offset = image_idx * 3
    drawn_images.add(image_key(
      images.base_sites[image_idx],
      images.jimages[offset],
      images.jimages[offset + 1],
      images.jimages[offset + 2],
    ))
  }
  const partner_is_drawn = (
    site: number,
    x: number,
    y: number,
    z: number,
  ): boolean =>
    (x >= 0 && x < dims[0] && y >= 0 && y < dims[1] && z >= 0 && z < dims[2]) ||
    drawn_images.has(image_key(site, x, y, z))

  let row = 0
  let visible_count = 0
  for (let image_idx = 0; image_idx < images.count; image_idx++) {
    const image_offset = image_idx * 3
    const anchor_site = images.base_sites[image_idx]
    const ix = images.jimages[image_offset]
    const iy = images.jimages[image_offset + 1]
    const iz = images.jimages[image_offset + 2]
    const lo = incident_offsets[anchor_site]
    const hi = incident_offsets[anchor_site + 1]
    for (let incident_idx = lo; incident_idx < hi; incident_idx++, row++) {
      const slot = incident_slots[incident_idx]
      const pair_offset = slot * 2
      const jimage_offset = slot * 3
      const a = graph.pairs[pair_offset]
      const b = graph.pairs[pair_offset + 1]
      // Ordinary self-image bonds choose A because this comparison is first.
      const anchor_is_a = a === anchor_site
      const dx = graph.jimages[jimage_offset]
      const dy = graph.jimages[jimage_offset + 1]
      const dz = graph.jimages[jimage_offset + 2]
      const ax = anchor_is_a ? ix : ix - dx
      const ay = anchor_is_a ? iy : iy - dy
      const az = anchor_is_a ? iz : iz - dz
      const bx = anchor_is_a ? ix + dx : ix
      const by = anchor_is_a ? iy + dy : iy
      const bz = anchor_is_a ? iz + dz : iz
      const partner_site = anchor_is_a ? b : a
      const partner_x = anchor_is_a ? bx : ax
      const partner_y = anchor_is_a ? by : ay
      const partner_z = anchor_is_a ? bz : az
      const complete = partner_is_drawn(partner_site, partner_x, partner_y, partner_z)
      const mode: BoundaryBondMode = complete
        ? BOUNDARY_BOND_MODE.FULL
        : policy === `hide`
          ? BOUNDARY_BOND_MODE.HIDDEN
          : BOUNDARY_BOND_MODE.STUB

      bond_indices[row] = slot
      image_indices[row] = image_idx
      anchor_sides[row] = anchor_is_a
        ? BOUNDARY_BOND_ANCHOR.A
        : BOUNDARY_BOND_ANCHOR.B
      modes[row] = mode
      const endpoint_offset = row * 3
      a_cells[endpoint_offset] = ax
      a_cells[endpoint_offset + 1] = ay
      a_cells[endpoint_offset + 2] = az
      b_cells[endpoint_offset] = bx
      b_cells[endpoint_offset + 1] = by
      b_cells[endpoint_offset + 2] = bz
      write_center(
        a_positions,
        endpoint_offset,
        a,
        ax,
        ay,
        az,
        positions,
        lattice,
      )
      write_center(
        b_positions,
        endpoint_offset,
        b,
        bx,
        by,
        bz,
        positions,
        lattice,
      )

      const anchor_positions = anchor_is_a ? a_positions : b_positions
      if (mode === BOUNDARY_BOND_MODE.FULL) {
        draw_starts[endpoint_offset] = a_positions[endpoint_offset]
        draw_starts[endpoint_offset + 1] = a_positions[endpoint_offset + 1]
        draw_starts[endpoint_offset + 2] = a_positions[endpoint_offset + 2]
        draw_ends[endpoint_offset] = b_positions[endpoint_offset]
        draw_ends[endpoint_offset + 1] = b_positions[endpoint_offset + 1]
        draw_ends[endpoint_offset + 2] = b_positions[endpoint_offset + 2]
        visible_count++
      } else if (mode === BOUNDARY_BOND_MODE.HIDDEN) {
        draw_starts[endpoint_offset] = anchor_positions[endpoint_offset]
        draw_starts[endpoint_offset + 1] = anchor_positions[endpoint_offset + 1]
        draw_starts[endpoint_offset + 2] = anchor_positions[endpoint_offset + 2]
        draw_ends[endpoint_offset] = anchor_positions[endpoint_offset]
        draw_ends[endpoint_offset + 1] = anchor_positions[endpoint_offset + 1]
        draw_ends[endpoint_offset + 2] = anchor_positions[endpoint_offset + 2]
      } else {
        const vx = b_positions[endpoint_offset] - a_positions[endpoint_offset]
        const vy = b_positions[endpoint_offset + 1] - a_positions[endpoint_offset + 1]
        const vz = b_positions[endpoint_offset + 2] - a_positions[endpoint_offset + 2]
        const length = Math.sqrt(vx * vx + vy * vy + vz * vz)
        let ux = 0
        let uy = 1
        let uz = 0
        if (length >= 1e-8) {
          const inverse_length = 1 / length
          ux = vx * inverse_length
          uy = vy * inverse_length
          uz = vz * inverse_length
        }
        const stub_length = length * 0.5 * stub_scale
        const direction = anchor_is_a ? 1 : -1
        draw_starts[endpoint_offset] = anchor_positions[endpoint_offset]
        draw_starts[endpoint_offset + 1] = anchor_positions[endpoint_offset + 1]
        draw_starts[endpoint_offset + 2] = anchor_positions[endpoint_offset + 2]
        draw_ends[endpoint_offset] =
          anchor_positions[endpoint_offset] + direction * ux * stub_length
        draw_ends[endpoint_offset + 1] =
          anchor_positions[endpoint_offset + 1] + direction * uy * stub_length
        draw_ends[endpoint_offset + 2] =
          anchor_positions[endpoint_offset + 2] + direction * uz * stub_length
        visible_count++
      }
    }
  }

  return {
    count,
    visible_count,
    bond_indices,
    image_indices,
    anchor_sides,
    modes,
    a_cells,
    b_cells,
    a_positions,
    b_positions,
    draw_starts,
    draw_ends,
  }
}

/** Build the complete immutable-by-convention ordinary periodic snapshot. */
export function build_periodic_decoration_snapshot(
  input: PeriodicDecorationSnapshotInput,
): PeriodicDecorationSnapshot {
  const dims = normalized_dims(input.dims)
  const policy = input.policy ?? `ghost-images`
  const stub_scale = input.stub_scale ?? 0.5
  const image_centers = build_periodic_image_centers(
    input.images,
    input.frame.positions,
    input.frame.lattice,
  )
  const boundary_segments = build_boundary_bond_endpoint_layout(
    input.graph,
    input.images,
    input.frame.positions,
    input.frame.lattice,
    { dims, policy, stub_scale },
  )
  return {
    graph: input.graph,
    frame: input.frame,
    dims,
    policy,
    stub_scale,
    images: input.images,
    image_centers,
    boundary_segments,
  }
}
