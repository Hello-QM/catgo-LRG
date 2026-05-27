// Browser-side port of server/catgo/routers/water_layer.py (non-equilibrate path).
// Used when the build flag __CATGO_VSCODE_EXTENSION__ is true so the Find Sites /
// add-water-layer feature works in the VS Code webview without a Python backend.

import type {
  ElementSymbol,
  Matrix3x3,
  Pbc,
  PymatgenLattice,
  PymatgenStructure,
  Site,
  Vec3,
} from '$lib/structure'
import { matrix_inverse_3x3 } from '$lib/math'
import spc216_text from './spc216.gro?raw'
import type { WaterLayerParams, WaterLayerResult } from './water-layer'

interface Spc216 {
  positions: Vec3[]
  box: number
}

let cached_spc216: Spc216 | null = null

function parse_spc216(text: string): Spc216 {
  const lines = text.split(/\r?\n/)
  const n_atoms = parseInt(lines[1].trim(), 10)
  const positions: Vec3[] = new Array(n_atoms)
  for (let i = 0; i < n_atoms; i++) {
    const line = lines[2 + i]
    const x = parseFloat(line.slice(20, 28)) * 10
    const y = parseFloat(line.slice(28, 36)) * 10
    const z = parseFloat(line.slice(36, 44)) * 10
    positions[i] = [x, y, z]
  }
  const box_line = lines[2 + n_atoms].trim().split(/\s+/)
  const box = parseFloat(box_line[0]) * 10

  // spc216 positions may be centred at the origin. Wrap each molecule as a
  // rigid unit so O lands in [0, L) and H atoms follow the same shift.
  const n_mol = positions.length / 3
  for (let m = 0; m < n_mol; m++) {
    const o = positions[m * 3]
    const sx = Math.floor(o[0] / box) * box
    const sy = Math.floor(o[1] / box) * box
    const sz = Math.floor(o[2] / box) * box
    for (let k = 0; k < 3; k++) {
      const p = positions[m * 3 + k]
      positions[m * 3 + k] = [p[0] - sx, p[1] - sy, p[2] - sz]
    }
  }
  return { positions, box }
}

function get_spc216(): Spc216 {
  if (cached_spc216) return cached_spc216
  cached_spc216 = parse_spc216(spc216_text)
  return cached_spc216
}

// cell is Matrix3x3 with rows = lattice vectors (pymatgen convention).
// cart = frac · cell
function cart_from_frac(frac: Vec3, cell: Matrix3x3): Vec3 {
  return [
    frac[0] * cell[0][0] + frac[1] * cell[1][0] + frac[2] * cell[2][0],
    frac[0] * cell[0][1] + frac[1] * cell[1][1] + frac[2] * cell[2][1],
    frac[0] * cell[0][2] + frac[1] * cell[1][2] + frac[2] * cell[2][2],
  ]
}

// frac = cart · cell_inv
function frac_from_cart(cart: Vec3, cell_inv: Matrix3x3): Vec3 {
  return [
    cart[0] * cell_inv[0][0] + cart[1] * cell_inv[1][0] + cart[2] * cell_inv[2][0],
    cart[0] * cell_inv[0][1] + cart[1] * cell_inv[1][1] + cart[2] * cell_inv[2][1],
    cart[0] * cell_inv[0][2] + cart[1] * cell_inv[1][2] + cart[2] * cell_inv[2][2],
  ]
}

function vec_len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function vec_dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vec_cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function det_3x3(m: Matrix3x3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

function rad_to_deg(r: number): number {
  return (r * 180) / Math.PI
}

// Build a PymatgenLattice from a Matrix3x3 (rows = lattice vectors).
function lattice_from_matrix(cell: Matrix3x3, pbc: Pbc): PymatgenLattice {
  const a_vec = cell[0]
  const b_vec = cell[1]
  const c_vec = cell[2]
  const a = vec_len(a_vec)
  const b = vec_len(b_vec)
  const c = vec_len(c_vec)
  const alpha = rad_to_deg(Math.acos(vec_dot(b_vec, c_vec) / (b * c)))
  const beta = rad_to_deg(Math.acos(vec_dot(a_vec, c_vec) / (a * c)))
  const gamma = rad_to_deg(Math.acos(vec_dot(a_vec, b_vec) / (a * b)))
  const volume = Math.abs(det_3x3(cell))
  return { matrix: cell, pbc, volume, a, b, c, alpha, beta, gamma }
}

// Compute the shortest distance between two Cartesian points under partial PBC
// by enumerating image shifts (±1 along each periodic axis).
function mic_distance(
  r1: Vec3,
  r2: Vec3,
  cell: Matrix3x3,
  pbc: [boolean, boolean, boolean],
): number {
  const dx = r1[0] - r2[0]
  const dy = r1[1] - r2[1]
  const dz = r1[2] - r2[2]
  const ax = pbc[0] ? [-1, 0, 1] : [0]
  const ay = pbc[1] ? [-1, 0, 1] : [0]
  const az = pbc[2] ? [-1, 0, 1] : [0]
  let min_d2 = Infinity
  for (const i of ax) {
    for (const j of ay) {
      for (const k of az) {
        const sx = i * cell[0][0] + j * cell[1][0] + k * cell[2][0]
        const sy = i * cell[0][1] + j * cell[1][1] + k * cell[2][1]
        const sz = i * cell[0][2] + j * cell[1][2] + k * cell[2][2]
        const ex = dx + sx
        const ey = dy + sy
        const ez = dz + sz
        const d2 = ex * ex + ey * ey + ez * ez
        if (d2 < min_d2) min_d2 = d2
      }
    }
  }
  return Math.sqrt(min_d2)
}

function calculate_n_water(xy_area: number, water_height: number, density: number): number {
  // density [g/cm³] × volume → number of water molecules
  const molecular_weight = 18.015
  const avogadro = 6.022e23
  const volume_ang3 = xy_area * water_height
  const volume_cm3 = volume_ang3 * 1e-24
  return Math.round((density * volume_cm3 * avogadro) / molecular_weight)
}

function pack_water_spc216(
  slab_positions: Vec3[],
  cell: Matrix3x3,
  z_start: number,
  z_end: number,
  min_distance: number,
): Vec3[] {
  const { positions: spc_positions, box: spc_box } = get_spc216()
  const n_spc_mol = spc_positions.length / 3
  const cell_inv = matrix_inverse_3x3(cell)

  // Convert z bounds to fractional c-coordinate.
  let frac_c_start = frac_from_cart([0, 0, z_start], cell_inv)[2]
  let frac_c_end = frac_from_cart([0, 0, z_end], cell_inv)[2]
  if (frac_c_start > frac_c_end) {
    const t = frac_c_start
    frac_c_start = frac_c_end
    frac_c_end = t
  }

  // Cartesian bounding box of the fill region: the parallelepiped slice
  // (frac_a, frac_b in [0,1), frac_c in [c_start, c_end]).
  let bbox_min: Vec3 = [Infinity, Infinity, Infinity]
  let bbox_max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const fa of [0, 1]) {
    for (const fb of [0, 1]) {
      for (const fc of [frac_c_start, frac_c_end]) {
        const v = cart_from_frac([fa, fb, fc], cell)
        for (let i = 0; i < 3; i++) {
          if (v[i] < bbox_min[i]) bbox_min[i] = v[i]
          if (v[i] > bbox_max[i]) bbox_max[i] = v[i]
        }
      }
    }
  }
  // 1 Å buffer for H atoms.
  bbox_min = [bbox_min[0] - 1, bbox_min[1] - 1, bbox_min[2] - 1]
  bbox_max = [bbox_max[0] + 1, bbox_max[1] + 1, bbox_max[2] + 1]

  const n_tiles: Vec3 = [
    Math.max(1, Math.ceil((bbox_max[0] - bbox_min[0]) / spc_box)),
    Math.max(1, Math.ceil((bbox_max[1] - bbox_min[1]) / spc_box)),
    Math.max(1, Math.ceil((bbox_max[2] - bbox_min[2]) / spc_box)),
  ]

  // Tile spc216 along Cartesian axes and filter by fractional coordinates.
  type Mol = [Vec3, Vec3, Vec3]
  const kept: Mol[] = []
  for (let ix = 0; ix < n_tiles[0]; ix++) {
    for (let iy = 0; iy < n_tiles[1]; iy++) {
      for (let iz = 0; iz < n_tiles[2]; iz++) {
        const ox = bbox_min[0] + ix * spc_box
        const oy = bbox_min[1] + iy * spc_box
        const oz = bbox_min[2] + iz * spc_box
        for (let m = 0; m < n_spc_mol; m++) {
          const op = spc_positions[m * 3]
          const o: Vec3 = [op[0] + ox, op[1] + oy, op[2] + oz]
          const frac = frac_from_cart(o, cell_inv)
          if (
            frac[0] >= 0 && frac[0] < 1 &&
            frac[1] >= 0 && frac[1] < 1 &&
            frac[2] >= frac_c_start && frac[2] <= frac_c_end
          ) {
            const h1p = spc_positions[m * 3 + 1]
            const h2p = spc_positions[m * 3 + 2]
            const h1: Vec3 = [h1p[0] + ox, h1p[1] + oy, h1p[2] + oz]
            const h2: Vec3 = [h2p[0] + ox, h2p[1] + oy, h2p[2] + oz]
            kept.push([o, h1, h2])
          }
        }
      }
    }
  }

  if (kept.length === 0) return []

  // Remove water molecules overlapping with slab atoms (PBC in a,b only).
  const slab_pbc: [boolean, boolean, boolean] = [true, true, false]
  if (slab_positions.length > 0) {
    const overlap_mol: Set<number> = new Set()
    const min_d2 = min_distance * min_distance
    for (let mi = 0; mi < kept.length; mi++) {
      if (overlap_mol.has(mi)) continue
      const mol = kept[mi]
      let any_close = false
      for (let a = 0; a < 3; a++) {
        const wp = mol[a]
        for (let s = 0; s < slab_positions.length; s++) {
          // Inline a squared-distance MIC for the inner loop hot path.
          const dx = wp[0] - slab_positions[s][0]
          const dy = wp[1] - slab_positions[s][1]
          const dz = wp[2] - slab_positions[s][2]
          for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
              const sx = i * cell[0][0] + j * cell[1][0]
              const sy = i * cell[0][1] + j * cell[1][1]
              const sz = i * cell[0][2] + j * cell[1][2]
              const ex = dx + sx
              const ey = dy + sy
              const ez = dz + sz
              const d2 = ex * ex + ey * ey + ez * ez
              if (d2 < min_d2) {
                any_close = true
                break
              }
            }
            if (any_close) break
          }
          if (any_close) break
        }
        if (any_close) break
      }
      if (any_close) overlap_mol.add(mi)
    }
    if (overlap_mol.size > 0) {
      const filtered: Mol[] = []
      for (let i = 0; i < kept.length; i++) if (!overlap_mol.has(i)) filtered.push(kept[i])
      kept.length = 0
      for (const m of filtered) kept.push(m)
    }
  }

  if (kept.length === 0) return []

  // Remove water-water overlaps across cell PBC boundaries. Where misaligned
  // spc216 tiles meet at the a/b PBC faces, atoms from different molecules can
  // interpenetrate. Check ALL cross-molecule atom pairs (not just O···H, which
  // missed overlapping oxygens — e.g. O-O at 1.6 Å with no O-H < 1.3). Per-pair
  // thresholds: O-O 2.0 Å (real nearest is ~2.8), O-H 1.3 Å (below the ~1.8 Å
  // H-bond distance so real H-bonds survive), H-H 1.3 Å. Drop the
  // higher-indexed molecule of each clashing pair.
  const CLASH_OO = 2.0
  const CLASH_OH = 1.3
  const CLASH_HH = 1.3
  const water_pbc: [boolean, boolean, boolean] = [true, true, true]
  const n_w = kept.length
  const remove_set: Set<number> = new Set()
  for (let i_mol = 0; i_mol < n_w; i_mol++) {
    if (remove_set.has(i_mol)) continue
    const [oi, hi1, hi2] = kept[i_mol]
    for (let j_mol = i_mol + 1; j_mol < n_w; j_mol++) {
      if (remove_set.has(j_mol)) continue
      const [oj, hj1, hj2] = kept[j_mol]
      const clash =
        mic_distance(oi, oj, cell, water_pbc) < CLASH_OO ||
        mic_distance(oi, hj1, cell, water_pbc) < CLASH_OH ||
        mic_distance(oi, hj2, cell, water_pbc) < CLASH_OH ||
        mic_distance(oj, hi1, cell, water_pbc) < CLASH_OH ||
        mic_distance(oj, hi2, cell, water_pbc) < CLASH_OH ||
        mic_distance(hi1, hj1, cell, water_pbc) < CLASH_HH ||
        mic_distance(hi1, hj2, cell, water_pbc) < CLASH_HH ||
        mic_distance(hi2, hj1, cell, water_pbc) < CLASH_HH ||
        mic_distance(hi2, hj2, cell, water_pbc) < CLASH_HH
      if (clash) remove_set.add(j_mol)
    }
  }
  if (remove_set.size > 0) {
    const filtered: Mol[] = []
    for (let i = 0; i < kept.length; i++) if (!remove_set.has(i)) filtered.push(kept[i])
    kept.length = 0
    for (const m of filtered) kept.push(m)
  }

  void slab_pbc // retained for symmetry with the Python source
  // Flatten to [O, H, H, O, H, H, ...].
  const out: Vec3[] = []
  for (const mol of kept) {
    out.push(mol[0], mol[1], mol[2])
  }
  return out
}

function clone_site(site: Site, abc: Vec3): Site {
  return {
    species: site.species.map((s) => ({ ...s })),
    abc,
    xyz: [site.xyz[0], site.xyz[1], site.xyz[2]],
    label: site.label,
    properties: { ...site.properties },
  }
}

function make_water_site(
  element: ElementSymbol,
  xyz: Vec3,
  abc: Vec3,
): Site {
  return {
    species: [{ element, occu: 1 }],
    abc,
    xyz,
    label: element,
    properties: { selective_dynamics: [true, true, true] },
  }
}

export async function add_water_layer_local(
  structure: PymatgenStructure,
  params: WaterLayerParams = {},
): Promise<WaterLayerResult> {
  const z_start = params.z_start ?? 0.0
  const z_end = params.z_end ?? 15.0
  const min_distance = params.min_distance ?? 2.0
  const density = 0.997 // matches server default

  if (z_start >= z_end) {
    throw new Error(`z_start (${z_start.toFixed(2)} Å) must be less than z_end (${z_end.toFixed(2)} Å)`)
  }

  let cell: Matrix3x3 = [
    [...structure.lattice.matrix[0]] as Vec3,
    [...structure.lattice.matrix[1]] as Vec3,
    [...structure.lattice.matrix[2]] as Vec3,
  ]
  const c_len_initial = vec_len(cell[2])

  // Auto-expand c-axis if z_end exceeds current cell along z.
  let c_axis_adjusted = false
  let new_c_length = c_len_initial
  const c_z = cell[2][2]
  if (z_end > c_z) {
    new_c_length = c_len_initial * ((z_end + 2.0) / c_z)
    c_axis_adjusted = true
    const scale = new_c_length / c_len_initial
    cell = [cell[0], cell[1], [cell[2][0] * scale, cell[2][1] * scale, cell[2][2] * scale]]
  }

  const cell_inv = matrix_inverse_3x3(cell)

  // Compute slab Cartesian positions (preserving existing xyz; abc may shift if
  // the c-axis was expanded, so recompute from new cell_inv).
  const slab_positions: Vec3[] = structure.sites.map((s) => [s.xyz[0], s.xyz[1], s.xyz[2]])
  const n_slab_atoms = slab_positions.length

  const a_vec = cell[0]
  const b_vec = cell[1]
  const ab_cross = vec_cross(a_vec, b_vec)
  const xy_area = vec_len(ab_cross)
  const water_height = z_end - z_start
  const n_water_target = calculate_n_water(xy_area, water_height, density)

  const empty_lattice = lattice_from_matrix(cell, structure.lattice.pbc)
  // Rebuild slab sites with possibly updated abc.
  const rebuilt_slab_sites: Site[] = structure.sites.map((s) =>
    clone_site(s, frac_from_cart(s.xyz, cell_inv))
  )

  if (n_water_target === 0) {
    return {
      structure: { ...structure, lattice: empty_lattice, sites: rebuilt_slab_sites },
      n_water_molecules: 0,
      n_atoms_added: 0,
      n_water_filled: 0,
      n_water_removed: 0,
      z_start,
      z_end,
      c_axis_adjusted,
      new_c_length,
      equilibrated: false,
      actual_density: 0,
      message: 'Region too small for any water molecules.',
    }
  }

  const water_positions = pack_water_spc216(
    slab_positions,
    cell,
    z_start,
    z_end,
    min_distance,
  )
  const n_water_placed = water_positions.length / 3

  if (n_water_placed === 0) {
    return {
      structure: { ...structure, lattice: empty_lattice, sites: rebuilt_slab_sites },
      n_water_molecules: 0,
      n_atoms_added: 0,
      n_water_filled: n_water_target,
      n_water_removed: 0,
      z_start,
      z_end,
      c_axis_adjusted,
      new_c_length,
      equilibrated: false,
      actual_density: 0,
      message: 'Could not place any water molecules. Try adjusting z range or min_distance.',
    }
  }

  // Build new sites: slab (unchanged xyz) + water atoms.
  const new_sites: Site[] = [...rebuilt_slab_sites]
  for (let i = 0; i < n_water_placed; i++) {
    const o_xyz = water_positions[i * 3]
    const h1_xyz = water_positions[i * 3 + 1]
    const h2_xyz = water_positions[i * 3 + 2]
    new_sites.push(make_water_site('O' as ElementSymbol, o_xyz, frac_from_cart(o_xyz, cell_inv)))
    new_sites.push(make_water_site('H' as ElementSymbol, h1_xyz, frac_from_cart(h1_xyz, cell_inv)))
    new_sites.push(make_water_site('H' as ElementSymbol, h2_xyz, frac_from_cart(h2_xyz, cell_inv)))
  }

  // Density should reflect the volume the water actually occupies, not the
  // full user-requested z range — min_distance pushes the bottom-most water
  // away from the slab and that gap is empty, not water.
  let min_water_z = Infinity
  for (const p of water_positions) {
    if (p[2] < min_water_z) min_water_z = p[2]
  }
  const effective_water_height = z_end - min_water_z
  const molecular_weight = 18.015
  const avogadro = 6.022e23
  const fill_volume_ang3 = xy_area * effective_water_height
  const fill_volume_cm3 = fill_volume_ang3 * 1e-24
  const actual_density = fill_volume_cm3 > 0
    ? (n_water_placed * molecular_weight) / (avogadro * fill_volume_cm3)
    : 0

  const result_structure: PymatgenStructure = {
    ...structure,
    lattice: empty_lattice,
    sites: new_sites,
  }
  void n_slab_atoms

  const parts: string[] = [
    `Packed ${n_water_placed} water molecules (${n_water_placed * 3} atoms) in z=[${z_start.toFixed(1)}, ${z_end.toFixed(1)}] Å`,
    `density: ${actual_density.toFixed(3)} g/cm³`,
  ]
  if (n_water_placed < n_water_target) {
    parts.push(`requested ${n_water_target}, placed ${n_water_placed}`)
  }
  if (c_axis_adjusted) {
    parts.push(`c-axis expanded to ${new_c_length.toFixed(1)} Å`)
  }
  parts.push('local TS impl (no LAMMPS equilibration)')

  return {
    structure: result_structure,
    n_water_molecules: n_water_placed,
    n_atoms_added: n_water_placed * 3,
    n_water_filled: n_water_target,
    n_water_removed: n_water_target - n_water_placed,
    z_start,
    z_end,
    c_axis_adjusted,
    new_c_length,
    equilibrated: false,
    actual_density,
    message: parts.join('; '),
  }
}
