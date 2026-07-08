// Periodic boundary conditions utilities
import type { Vec3 } from '$lib'
import { element_data } from '$lib/element'
import * as math from '$lib/math'
import type { ParsedStructure } from './parse'
import { wasm_find_pbc_images } from './ferrox-wasm'

// Covalent radii lookup (Å) for bond-distance checks — same source as bonding.ts
const covalent_radii: Map<string, number> = new Map(
  element_data.filter((el) => el.covalent_radius !== null).map((
    el,
  ) => [el.symbol, el.covalent_radius as number]),
)

export type Pbc = readonly [boolean, boolean, boolean]

// Wrap fractional coordinates to [0, 1) range for periodicity.
export const wrap_to_unit_cell = (frac: Vec3): Vec3 =>
  frac.map((coord) => {
    const wrapped = ((coord % 1) + 1) % 1
    return wrapped >= 1 - 1e-10 ? 0 : wrapped // clamp near-1 to 0 for float precision
  }) as Vec3

export function find_image_atoms(
  structure: ParsedStructure,
  { tolerance = 0.05 }: { tolerance?: number } = {},
): [number, Vec3, Vec3][] {
  // Find image atoms for PBC. Returns [atom_idx, image_xyz, image_abc] tuples.
  // Skips image generation for trajectory data with scattered atoms.
  if (!structure.lattice || !structure.sites || structure.sites.length === 0) return []

  // Skip trajectory data (>10% atoms outside cell)
  const atoms_outside_cell = structure.sites.filter(({ abc }) =>
    abc.some((coord) => coord < -0.1 || coord > 1.1)
  )
  // Skip image generation for trajectory data (>10% atoms outside cell)
  if (atoms_outside_cell.length > structure.sites.length * 0.1) {
    return []
  }

  // Get periodic boundary conditions - default to all periodic if not specified
  // pbc[dim] = true means dimension is periodic (should generate images)
  // pbc[dim] = false means dimension is non-periodic (no images, e.g., slab vacuum direction)
  // Convert Proxy to plain array if needed (Svelte reactivity)
  const rawPbc = (structure.lattice as { pbc?: Pbc }).pbc
  const pbc: Pbc = rawPbc ? [rawPbc[0], rawPbc[1], rawPbc[2]] : [true, true, true]

  // Check if this is a supercell to correctly identify external boundaries correctly
  const image_sites: [number, Vec3, Vec3][] = []
  const lattice_vecs = structure.lattice.matrix

  const FRACTIONAL_EPS = 1e-9
  // Scale zero-displacement threshold by lattice length scale to avoid hard-coded magic numbers
  const lattice_norm = Math.max(
    Math.hypot(...lattice_vecs[0]),
    Math.hypot(...lattice_vecs[1]),
    Math.hypot(...lattice_vecs[2]),
  )
  const displacement_eps_sq = (Number.EPSILON * lattice_norm) ** 2

  // Note: tolerance (default 0.05) determines boundary detection for image generation,
  // while FRACTIONAL_EPS (1e-9) nudges image placement slightly inside cell boundaries
  // to avoid wrap inconsistencies. These serve different purposes, not to be conflated.

  for (const [idx, site] of structure.sites.entries()) {
    // Find edge dimensions and translation directions
    const edge_dims: { dim: number; direction: number }[] = []

    // Find boundary dimensions (only in periodic directions)
    for (let dim = 0; dim < 3; dim++) {
      // Skip non-periodic dimensions (e.g., vacuum direction in slabs)
      if (!pbc[dim]) continue
      const coord = site.abc[dim]
      if (Math.abs(coord) < tolerance) edge_dims.push({ dim, direction: 1 })
      if (Math.abs(coord - 1) < tolerance) edge_dims.push({ dim, direction: -1 })
    }

    // Generate all translation combinations
    for (let mask = 1; mask < (1 << edge_dims.length); mask++) {
      // Track selected translation per dimension. If both +1 and -1 are selected for a dim,
      // the net shift is zero and we skip because it yields no image.
      const selected_shift: Vec3 = [0, 0, 0]
      for (let bit = 0; bit < edge_dims.length; bit++) {
        if (mask & (1 << bit)) {
          const { dim, direction } = edge_dims[bit]
          selected_shift[dim] += direction
        }
      }

      // Early skip if no net shift across any dimension
      if (selected_shift.every((val) => val === 0)) continue

      // Build fractional coordinates positioned just inside the cell boundary
      // (instead of exactly at 0/1). This avoids wrap inconsistencies across
      // supercells and oblique lattices and guarantees a non-zero displacement.
      const img_abc: Vec3 = [...site.abc]
      for (let dim = 0; dim < 3; dim++) {
        if (selected_shift[dim] > 0) img_abc[dim] = 1 - FRACTIONAL_EPS
        else if (selected_shift[dim] < 0) img_abc[dim] = FRACTIONAL_EPS
      }

      // If no dimension actually shifted, continue
      if (
        img_abc[0] === site.abc[0] && img_abc[1] === site.abc[1] &&
        img_abc[2] === site.abc[2]
      ) continue

      // Compute xyz from img_abc to ensure consistency
      const img_xyz = math.add(
        math.scale(lattice_vecs[0], img_abc[0]),
        math.scale(lattice_vecs[1], img_abc[1]),
        math.scale(lattice_vecs[2], img_abc[2]),
      ) as Vec3

      // Skip zero-displacement images (should not happen with epsilon nudging)
      const displacement = math.subtract(img_xyz, site.xyz) as Vec3
      const displacement_len_sq = displacement.reduce((sum, val) => sum + val * val, 0)
      if (displacement_len_sq < displacement_eps_sq) continue

      image_sites.push([idx, img_xyz, img_abc])
    }
  }

  return image_sites
}

// Plain copies of the per-site geometry, extracted in ONE pass.
//
// The structures handed to these functions are usually Svelte `$state`
// proxies: every `sites[i].xyz[k]` access inside a hot loop is a proxy trap.
// The image search touches coordinates billions of times for ~10k-atom
// systems, which turned an O(n) algorithm into a multi-minute UI freeze
// (profiled: 104s self-time in get_pbc_image_sites + 84s in proxy `get` for
// an 11k-atom LAMMPS data file). Extract once, loop over typed arrays.
interface PlainGeometry {
  n: number
  xyz: Float64Array
  abc: Float64Array
  elem: (string | undefined)[]
}

function extract_plain_geometry(structure: ParsedStructure): PlainGeometry {
  const sites = structure.sites
  const n = sites.length
  const xyz = new Float64Array(3 * n)
  const abc = new Float64Array(3 * n)
  const elem = new Array<string | undefined>(n)
  for (let i = 0; i < n; i++) {
    const s = sites[i]
    const p = s.xyz
    const q = s.abc
    xyz[3 * i] = p[0]
    xyz[3 * i + 1] = p[1]
    xyz[3 * i + 2] = p[2]
    abc[3 * i] = q[0]
    abc[3 * i + 1] = q[1]
    abc[3 * i + 2] = q[2]
    elem[i] = s.species[0]?.element
  }
  return { n, xyz, abc, elem }
}

// Translational image generation (VESTA/Avogadro approach):
// For each atom, check all 26 neighboring cell translations.
// Keep the image if its fractional coordinates fall within the display range.
// Deduplicate by Cartesian distance.
//
// This is purely geometric — no bond logic needed. It works correctly for
// all structure types (metals, dense inorganics, molecular crystals) because
// it simply shows which atoms fall within the display boundaries.
export function find_translational_images(
  structure: ParsedStructure,
  { range_min = -0.01, range_max = 1.01 }: { range_min?: number; range_max?: number } = {},
  geom?: PlainGeometry,
): [number, Vec3, Vec3][] {
  if (!structure.lattice || !structure.sites || structure.sites.length === 0) return []

  const g = geom ?? extract_plain_geometry(structure)
  const n = g.n
  const gabc = g.abc
  const gxyz = g.xyz

  // Skip trajectory data (>10% atoms outside cell)
  let atoms_outside = 0
  for (let i = 0; i < n; i++) {
    const a = gabc[3 * i], b = gabc[3 * i + 1], c = gabc[3 * i + 2]
    if (a < -0.1 || a > 1.1 || b < -0.1 || b > 1.1 || c < -0.1 || c > 1.1) atoms_outside++
  }
  if (atoms_outside > n * 0.1) return []

  const rawPbc = (structure.lattice as { pbc?: Pbc }).pbc
  const pbc: Pbc = rawPbc ? [rawPbc[0], rawPbc[1], rawPbc[2]] : [true, true, true]
  const lattice_vecs = structure.lattice.matrix
  const lattice_T = math.transpose_3x3_matrix(lattice_vecs)

  // All 26 neighbor cell offsets, filtered by PBC flags
  const offsets: Vec3[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        if (!pbc[0] && dx !== 0) continue
        if (!pbc[1] && dy !== 0) continue
        if (!pbc[2] && dz !== 0) continue
        offsets.push([dx, dy, dz])
      }
    }
  }

  // Spatial-grid deduplication: O(1) per query instead of O(n) linear scan.
  // Uses string keys (collision-free) instead of integer hashes (which can
  // collide and falsely reject valid image atoms, causing missing boundary bonds).
  const dedup_tol_sq = 0.01 * 0.01
  const DEDUP_CELL = 0.05 // > sqrt(dedup_tol_sq) to ensure overlap detection
  const dedup_inv = 1 / DEDUP_CELL
  const dedup_grid = new Map<string, Vec3[]>()

  function dedup_key(x: number, y: number, z: number): string {
    return `${Math.floor(x * dedup_inv)}|${Math.floor(y * dedup_inv)}|${Math.floor(z * dedup_inv)}`
  }

  function dedup_add(xyz: Vec3) {
    const key = dedup_key(xyz[0], xyz[1], xyz[2])
    let cell = dedup_grid.get(key)
    if (!cell) { cell = []; dedup_grid.set(key, cell) }
    cell.push(xyz)
  }

  function dedup_has(xyz: Vec3): boolean {
    const cx = Math.floor(xyz[0] * dedup_inv)
    const cy = Math.floor(xyz[1] * dedup_inv)
    const cz = Math.floor(xyz[2] * dedup_inv)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const cell = dedup_grid.get(`${cx + di}|${cy + dj}|${cz + dk}`)
          if (!cell) continue
          for (const exyz of cell) {
            const ddx = xyz[0] - exyz[0], ddy = xyz[1] - exyz[1], ddz = xyz[2] - exyz[2]
            if (ddx * ddx + ddy * ddy + ddz * ddz < dedup_tol_sq) return true
          }
        }
      }
    }
    return false
  }

  // Seed grid with all original atoms (plain copies, not proxy-backed arrays —
  // dedup_has re-reads stored entries on every collision check)
  for (let i = 0; i < n; i++) {
    dedup_add([gxyz[3 * i], gxyz[3 * i + 1], gxyz[3 * i + 2]])
  }

  const result: [number, Vec3, Vec3][] = []

  for (let idx = 0; idx < n; idx++) {
    const sa = gabc[3 * idx], sb = gabc[3 * idx + 1], sc = gabc[3 * idx + 2]

    for (const [dx, dy, dz] of offsets) {
      const img_abc: Vec3 = [sa + dx, sb + dy, sc + dz]

      if (img_abc[0] < range_min || img_abc[0] > range_max) continue
      if (img_abc[1] < range_min || img_abc[1] > range_max) continue
      if (img_abc[2] < range_min || img_abc[2] > range_max) continue

      const img_xyz = math.mat3x3_vec3_multiply(lattice_T, img_abc)

      if (dedup_has(img_xyz)) continue

      dedup_add(img_xyz)
      result.push([idx, img_xyz, img_abc])
    }
  }

  return result
}

// Return structure with bond-completing image atoms added (VESTA-like boundary completion)
export function get_pbc_image_sites(
  structure: ParsedStructure,
): ParsedStructure & { num_original_sites?: number; image_to_original_map?: number[] } {
  if (!structure || !structure.sites || structure.sites.length === 0) {
    return structure
  }

  // One proxy-free pass over the sites; every loop below reads from this.
  const geom = extract_plain_geometry(structure)

  // Check for trajectory data
  let atoms_outside_cell = 0
  for (let i = 0; i < geom.n; i++) {
    const a = geom.abc[3 * i], b = geom.abc[3 * i + 1], c = geom.abc[3 * i + 2]
    if (a < -0.1 || a > 1.1 || b < -0.1 || b > 1.1 || c < -0.1 || c > 1.1) atoms_outside_cell++
  }

  // Return trajectory data unchanged
  if (atoms_outside_cell > geom.n * 0.1) {
    return structure
  }

  // Two-phase approach matching VESTA:
  //
  // Phase 1 (Avogadro/VESTA core): Translational images within [-0.05, 1.05].
  // Shows atoms at cell boundaries. Purely geometric, no bond logic.
  //
  // Phase 2 (VESTA Mode 2 "bond completion"): For each image atom, ensure all
  // its bonded neighbors in the original cell also have images at the same
  // offset. This prevents orphan atoms with dangling bonds at the boundary.
  // Only adds the IMMEDIATE bonded neighbors — no recursive chain growth.
  const initial_images = find_translational_images(structure, {
    range_min: -0.05,
    range_max: 1.05,
  }, geom)

  // Phase 2: bond-complete the image set.
  // For each image atom, ensure all its bonded neighbors also have images
  // at the same offset (prevents orphan atoms with dangling bonds).
  //
  // Uses spatial grid (cell list) with adaptive cutoff based on covalent radii.
  // Grid cell size = max possible bond length so each atom only checks 27 cells.
  // Complexity: O(n) average for uniform atom distributions.
  const n = geom.n
  const gxyz = geom.xyz
  const gabc = geom.abc
  const BOND_TOLERANCE = 1.25 // bond if dist < (r_i + r_j) * tolerance
  const BOND_MIN_SQ = 0.01   // 0.1² — skip near-zero distances

  // Per-atom covalent radii (pre-lookup for inner loop)
  const radii = new Float64Array(n)
  let max_radius = 0
  for (let i = 0; i < n; i++) {
    const r = covalent_radii.get(geom.elem[i]!) ?? 1.5 // already in Å
    radii[i] = r
    if (r > max_radius) max_radius = r
  }
  const MAX_BOND = 2 * max_radius * BOND_TOLERANCE // global upper bound for grid cell size

  // Build spatial grid
  const adj: number[][] = Array.from({ length: n }, () => [])

  if (n > 0) {
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity
    let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity
    for (let i = 0; i < n; i++) {
      const x = gxyz[3 * i], y = gxyz[3 * i + 1], z = gxyz[3 * i + 2]
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x
      if (y < by0) by0 = y; if (y > by1) by1 = y
      if (z < bz0) bz0 = z; if (z > bz1) bz1 = z
    }

    const cell_size = Math.max(MAX_BOND, 0.5) // minimum cell size 0.5 Å
    const inv = 1 / cell_size
    const nx = Math.max(1, Math.ceil((bx1 - bx0) * inv) + 1)
    const ny = Math.max(1, Math.ceil((by1 - by0) * inv) + 1)
    const nz = Math.max(1, Math.ceil((bz1 - bz0) * inv) + 1)
    const grid = new Map<number, number[]>()

    for (let i = 0; i < n; i++) {
      const x = gxyz[3 * i], y = gxyz[3 * i + 1], z = gxyz[3 * i + 2]
      const key = Math.floor((x - bx0) * inv) * ny * nz
               + Math.floor((y - by0) * inv) * nz
               + Math.floor((z - bz0) * inv)
      let cell = grid.get(key)
      if (!cell) { cell = []; grid.set(key, cell) }
      cell.push(i)
    }

    // Neighbor search: 27 adjacent cells, per-pair adaptive cutoff
    for (const [key, cell] of grid) {
      const ci = Math.floor(key / (ny * nz))
      const cj = Math.floor((key % (ny * nz)) / nz)
      const ck = key % nz
      for (let di = -1; di <= 1; di++) {
        const ni = ci + di; if (ni < 0 || ni >= nx) continue
        for (let dj = -1; dj <= 1; dj++) {
          const nj = cj + dj; if (nj < 0 || nj >= ny) continue
          for (let dk = -1; dk <= 1; dk++) {
            const nk = ck + dk; if (nk < 0 || nk >= nz) continue
            const ncell = grid.get(ni * ny * nz + nj * nz + nk)
            if (!ncell) continue
            for (const i of cell) {
              const xi = gxyz[3 * i], yi = gxyz[3 * i + 1], zi = gxyz[3 * i + 2]
              const ri = radii[i]
              for (const j of ncell) {
                if (j <= i) continue
                const dx = xi - gxyz[3 * j]
                const dy = yi - gxyz[3 * j + 1]
                const dz = zi - gxyz[3 * j + 2]
                const d2 = dx * dx + dy * dy + dz * dz
                if (d2 < BOND_MIN_SQ) continue
                const bond_max = (ri + radii[j]) * BOND_TOLERANCE
                if (d2 < bond_max * bond_max) {
                  adj[i].push(j)
                  adj[j].push(i)
                }
              }
            }
          }
        }
      }
    }
  }

  // For each existing image, add missing bonded neighbors at the same offset
  const lattice_T = math.transpose_3x3_matrix(structure.lattice!.matrix)
  const image_set = new Set<string>()
  for (const [idx, , abc] of initial_images) {
    const o0 = Math.round(abc[0] - gabc[3 * idx])
    const o1 = Math.round(abc[1] - gabc[3 * idx + 1])
    const o2 = Math.round(abc[2] - gabc[3 * idx + 2])
    image_set.add(`${idx}|${o0},${o1},${o2}`)
  }

  const extra_images: [number, Vec3, Vec3][] = []
  for (const [idx, , abc] of initial_images) {
    const o0 = Math.round(abc[0] - gabc[3 * idx])
    const o1 = Math.round(abc[1] - gabc[3 * idx + 1])
    const o2 = Math.round(abc[2] - gabc[3 * idx + 2])
    for (const nb of adj[idx]) {
      const nb_key = `${nb}|${o0},${o1},${o2}`
      if (image_set.has(nb_key)) continue
      const nb_abc: Vec3 = [
        gabc[3 * nb] + o0,
        gabc[3 * nb + 1] + o1,
        gabc[3 * nb + 2] + o2,
      ]
      const nb_xyz = math.mat3x3_vec3_multiply(lattice_T, nb_abc)
      image_set.add(nb_key)
      extra_images.push([nb, nb_xyz, nb_abc])
    }
  }

  const image_sites = [...initial_images, ...extra_images]
  const num_original_sites = structure.sites.length
  const image_to_original_map: number[] = []
  const imaged_struct = {
    ...structure,
    sites: [...structure.sites],
    num_original_sites,
    image_to_original_map,
  }

  for (const [site_idx, img_xyz, img_abc] of image_sites) {
    const orig_site = structure.sites[site_idx]
    imaged_struct.sites.push({
      ...orig_site,
      abc: img_abc,
      xyz: img_xyz,
      properties: { ...orig_site.properties, orig_site_idx: site_idx },
    })
    image_to_original_map.push(site_idx)
  }

  return imaged_struct
}

/**
 * Generate periodic repeat images for display (VESTA-like "Drawing Boundaries").
 * Creates copies of ALL atoms shifted by integer lattice translations.
 * repeats: [ra, rb, rc] — number of extra repeats in each direction (e.g., [1,1,1] = 3x3x3 grid)
 */
export function get_periodic_repeat_sites(
  structure: ParsedStructure,
  repeats: Vec3 = [0, 0, 0],
): ParsedStructure & { num_original_sites?: number; image_to_original_map?: number[] } {
  if (!structure?.lattice?.matrix || !structure.sites?.length) return structure
  if (repeats[0] === 0 && repeats[1] === 0 && repeats[2] === 0) {
    return get_pbc_image_sites(structure)
  }

  const MAX_REPEAT_ATOMS = 50_000
  const total_copies = (2 * repeats[0] + 1) * (2 * repeats[1] + 1) * (2 * repeats[2] + 1) - 1
  if (total_copies * structure.sites.length > MAX_REPEAT_ATOMS) {
    console.warn(`[pbc] Periodic repeat would produce ${total_copies * structure.sites.length} atoms — capped. Falling back to boundary images.`)
    return get_pbc_image_sites(structure)
  }

  const rawPbc = (structure.lattice as { pbc?: Pbc }).pbc
  const pbc: Pbc = rawPbc ? [rawPbc[0], rawPbc[1], rawPbc[2]] : [true, true, true]
  const lattice_vecs = structure.lattice.matrix
  const num_original_sites = structure.sites.length
  const image_to_original_map: number[] = []
  const new_sites = [...structure.sites]

  for (let da = -repeats[0]; da <= repeats[0]; da++) {
    for (let db = -repeats[1]; db <= repeats[1]; db++) {
      for (let dc = -repeats[2]; dc <= repeats[2]; dc++) {
        if (da === 0 && db === 0 && dc === 0) continue
        if (da !== 0 && !pbc[0]) continue
        if (db !== 0 && !pbc[1]) continue
        if (dc !== 0 && !pbc[2]) continue

        for (let i = 0; i < num_original_sites; i++) {
          const site = structure.sites[i]
          const img_abc: Vec3 = [site.abc[0] + da, site.abc[1] + db, site.abc[2] + dc]
          const img_xyz = math.add(
            math.scale(lattice_vecs[0], img_abc[0]),
            math.scale(lattice_vecs[1], img_abc[1]),
            math.scale(lattice_vecs[2], img_abc[2]),
          ) as Vec3
          new_sites.push({
            ...site,
            abc: img_abc,
            xyz: img_xyz,
            properties: { ...site.properties, orig_site_idx: i },
          })
          image_to_original_map.push(i)
        }
      }
    }
  }

  return { ...structure, sites: new_sites, num_original_sites, image_to_original_map }
}

// Deduplicate atoms that are periodic images of each other in the structure.
// Two atoms are periodic images if their fractional coordinates differ by an integer
// translation vector in periodic directions (translational symmetry).
// This is needed after operations like slab cutting where atoms at both boundaries
// (e.g., fractional coord 0 and 1) might be created as separate sites.
// Returns a new structure with duplicate atoms removed.
export function deduplicate_periodic_images(
  structure: ParsedStructure,
  { tolerance = 0.02 }: { tolerance?: number } = {},
): ParsedStructure {
  if (!structure.lattice || !structure.sites || structure.sites.length === 0) {
    return structure
  }

  // Get periodic boundary conditions - default to all periodic
  // Convert Proxy to plain array if needed (Svelte reactivity)
  const rawPbc = (structure.lattice as { pbc?: Pbc }).pbc
  const pbc: Pbc = rawPbc ? [rawPbc[0], rawPbc[1], rawPbc[2]] : [true, true, true]

  console.log(`[pbc] deduplicate_periodic_images: ${structure.sites.length} sites, pbc=[${pbc.join(',')}]`)

  // Check if two atoms are periodic images of each other using translational symmetry.
  // They are images if their fractional coordinates differ by an integer in periodic directions
  // and are equal (within tolerance) in non-periodic directions.
  function are_periodic_images(abc1: Vec3, abc2: Vec3): boolean {
    for (let dim = 0; dim < 3; dim++) {
      const diff = abc1[dim] - abc2[dim]
      if (pbc[dim]) {
        // In periodic direction: difference should be close to an integer (0, ±1, ±2, etc.)
        const rounded = Math.round(diff)
        if (Math.abs(diff - rounded) > tolerance) return false
      } else {
        // In non-periodic direction: coordinates must be equal
        if (Math.abs(diff) > tolerance) return false
      }
    }
    return true
  }

  // Wrap fractional coordinates to [0, 1) for periodic dimensions
  function wrap_to_unit_cell_local(abc: Vec3): Vec3 {
    const wrapped: Vec3 = [...abc]
    for (let dim = 0; dim < 3; dim++) {
      if (pbc[dim]) {
        wrapped[dim] = ((abc[dim] % 1) + 1) % 1
        // Clamp near-1 to 0 for consistency
        if (wrapped[dim] > 1 - 1e-6) wrapped[dim] = 0
      }
    }
    return wrapped
  }

  // Track which sites to keep (indices into original sites array)
  const keep_indices: number[] = []
  // Store original positions of kept atoms for comparison
  const kept_atoms: { idx: number; element: string; abc: Vec3 }[] = []
  let duplicates_found = 0

  for (let idx = 0; idx < structure.sites.length; idx++) {
    const site = structure.sites[idx]
    const element = site.species[0]?.element ?? 'X'

    // Check if this atom is a periodic image of any kept atom (translational symmetry check)
    let is_image = false
    let matched_idx = -1
    for (const kept of kept_atoms) {
      if (kept.element === element && are_periodic_images(site.abc, kept.abc)) {
        is_image = true
        matched_idx = kept.idx
        break
      }
    }

    if (is_image) {
      duplicates_found++
      if (duplicates_found <= 10) {
        console.log(`[pbc] Image atom found: site ${idx} (${element} at [${site.abc.map(v => v.toFixed(4)).join(',')}]) ≡ site ${matched_idx} (translational symmetry)`)
      }
    } else {
      keep_indices.push(idx)
      kept_atoms.push({ idx, element, abc: site.abc })
    }
  }

  if (keep_indices.length === structure.sites.length) {
    console.log(`[pbc] No periodic image duplicates found in ${structure.sites.length} sites`)
  } else {
    console.log(`[pbc] Found ${duplicates_found} periodic image atoms, keeping ${keep_indices.length} of ${structure.sites.length}`)
  }

  // Build new sites array with only kept atoms
  // Also wrap coordinates to [0, 1) for kept atoms
  const new_sites = keep_indices.map((idx) => {
    const site = structure.sites[idx]
    const wrapped_abc = wrap_to_unit_cell_local(site.abc)
    // Recompute xyz from wrapped abc
    const lattice_vecs = structure.lattice!.matrix
    const new_xyz = math.add(
      math.scale(lattice_vecs[0], wrapped_abc[0]),
      math.scale(lattice_vecs[1], wrapped_abc[1]),
      math.scale(lattice_vecs[2], wrapped_abc[2]),
    ) as Vec3
    return { ...site, abc: wrapped_abc, xyz: new_xyz }
  })

  console.log(`[pbc] Deduplicated structure: ${structure.sites.length} -> ${new_sites.length} sites`)

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Generate PBC image sites using WASM (fast) with JS fallback.
 * For 100K+ atoms, WASM is ~10-50x faster than JS.
 */
export async function find_pbc_images_fast(
  structure: ParsedStructure,
  options?: { range_min?: number; range_max?: number; bond_completion?: boolean; bond_tolerance?: number },
): Promise<ParsedStructure & { num_original_sites?: number; image_to_original_map?: number[] }> {
  if (!structure?.sites?.length || !structure.lattice) return structure

  // Try WASM first.
  // bond_completion defaults to FALSE so the ghost atom set matches Phase 7's
  // crystaltoolkit-style enumeration (`build_sites_to_draw`) — only atoms
  // whose frac coord sits within `[range_min, range_max]` are reflected. The
  // older default (true) pulled covalent neighbors of every reflected atom
  // out across the cell boundary, producing the "halo of unbonded balls
  // around the unit cell" artefact when Phase 7 image-atom decorator bonds
  // didn't recognize those extra ghosts. Callers that want VESTA-style
  // bond-completion can still opt in by passing `bond_completion: true`.
  const wasm_result = await wasm_find_pbc_images(
    structure as any,
    options ?? { range_min: -0.05, range_max: 1.05, bond_completion: false, bond_tolerance: 1.25 },
  )

  // wasm_result === null means the WASM path FAILED (module unavailable or
  // errored) — only then is the JS fallback justified. A successful run with
  // zero images is a real answer; falling through to the JS path re-did the
  // whole search on the main thread (and through the Svelte proxy, which
  // freezes the UI for minutes on ~10k-atom systems).
  if (wasm_result && wasm_result.parent_indices.length === 0) {
    return structure
  }
  if (wasm_result && wasm_result.parent_indices.length > 0) {
    const num_original_sites = structure.sites.length
    const image_to_original_map: number[] = [...wasm_result.parent_indices]
    const imaged_struct = {
      ...structure,
      sites: [...structure.sites],
      num_original_sites,
      image_to_original_map,
    }

    for (let i = 0; i < wasm_result.parent_indices.length; i++) {
      const site_idx = wasm_result.parent_indices[i]
      const orig_site = structure.sites[site_idx]
      imaged_struct.sites.push({
        ...orig_site,
        abc: wasm_result.positions_abc[i] as Vec3,
        xyz: wasm_result.positions_xyz[i] as Vec3,
        properties: { ...orig_site.properties, orig_site_idx: site_idx },
      })
    }

    return imaged_struct
  }

  // JS fallback (WASM not ready or returned empty)
  return get_pbc_image_sites(structure)
}
