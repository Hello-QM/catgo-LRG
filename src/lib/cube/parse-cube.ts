/**
 * Client-side cube file parser.
 * Parses atom positions and volumetric grid data from Gaussian .cube files.
 * Converts to PymatgenMolecule-compatible structures for the Structure viewer.
 */

import { elem_symbols } from '$lib/labels'
import type {
  ElementSymbol,
  Matrix3x3,
  Pbc,
  PymatgenLattice,
  PymatgenMolecule,
  Site,
  Vec3,
} from '$lib'
import { calc_lattice_params } from '$lib/math'
import { cartesian_to_fractional } from '$lib/structure/lattice-ops'
import type { CubeHeader } from './api'

const BOHR_TO_ANGSTROM = 0.529177210903

interface CubeAtomRaw {
  atomic_number: number
  charge: number
  position: [number, number, number] // Angstrom
}

export interface ParsedCubeHeader {
  atoms: CubeAtomRaw[]
  n_atoms: number
  origin: [number, number, number]
  dims: [number, number, number]
  /**
   * Per-voxel axis vectors (Angstrom). Row i is the displacement of one grid
   * step along grid axis i. The cell/lattice vector for axis i is
   * `voxel_axes[i] * dims[i]`. Populated by `parse_cube_header` so the lattice
   * can be derived for periodic (VASP) charge files.
   */
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  is_angstrom: boolean
}

export interface VolumetricGrid {
  data: Float32Array // flat [nx][ny][nz] row-major
  dims: [number, number, number]
  origin: [number, number, number] // Angstroms
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  data_min: number
  data_max: number
}

export interface ParsedCubeData {
  header: CubeHeader
  grid: VolumetricGrid
}

function cube_number(token: string | undefined, label: string): number {
  const normalized = token?.replace(/[dD]/u, `e`) ?? ``
  const value = Number(normalized)
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(normalized)
    || !Number.isFinite(value)) {
    throw new Error(`Invalid Cube ${label}: ${token ?? `missing value`}`)
  }
  return value
}

function cube_integer(token: string | undefined, label: string): number {
  if (!/^[+-]?\d+$/u.test(token ?? ``)) throw new Error(`Invalid Cube ${label}`)
  const value = Number(token)
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid Cube ${label}`)
  return value
}

function cube_fields(lines: string[], index: number, count: number): string[] {
  const fields = lines[index]?.trim().split(/\s+/u) ?? []
  if (fields.length < count) throw new Error(`Incomplete Cube record on line ${index + 1}`)
  return fields
}

function read_cube_header(lines: string[]): { header: CubeHeader; orbital: boolean } {
  if (lines.length < 6) throw new Error(`Invalid cube file: too few lines`)
  const fields = cube_fields(lines, 2, 4)
  const raw_n_atoms = cube_integer(fields[0], `atom count`)
  const n_atoms = Math.abs(raw_n_atoms)
  const nval = fields[4] === undefined ? 1 : cube_integer(fields[4], `NVAL`)
  if (nval !== 1) throw new Error(`Multiple Cube datasets (NVAL=${nval}) are not supported`)
  if (n_atoms > lines.length - 6) throw new Error(`Incomplete Cube atom records`)

  // The sign of NATOMS denotes orbital metadata, never coordinate units.
  // Gaussian Cube coordinates and axes are in Bohr for either sign.
  const vector = (parts: string[], offset: number): [number, number, number] => [
    cube_number(parts[offset], `coordinate`) * BOHR_TO_ANGSTROM,
    cube_number(parts[offset + 1], `coordinate`) * BOHR_TO_ANGSTROM,
    cube_number(parts[offset + 2], `coordinate`) * BOHR_TO_ANGSTROM,
  ]
  const origin = vector(fields, 1)
  const dims: [number, number, number] = [0, 0, 0]
  const voxel_axes: VolumetricGrid['voxel_axes'] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    const axis = cube_fields(lines, 3 + i, 4)
    dims[i] = cube_integer(axis[0], `grid dimension`)
    if (dims[i] <= 0) throw new Error(`Cube grid dimensions must be positive`)
    voxel_axes[i] = vector(axis, 1)
  }
  if (!Number.isSafeInteger(dims[0] * dims[1] * dims[2])) {
    throw new Error(`Cube grid dimensions overflow`)
  }

  const atoms: CubeAtomRaw[] = []
  for (let i = 0; i < n_atoms; i++) {
    const atom = cube_fields(lines, 6 + i, 5)
    atoms.push({
      atomic_number: cube_integer(atom[0], `atomic number`),
      charge: cube_number(atom[1], `charge`),
      position: vector(atom, 2),
    })
  }
  return {
    header: { comment1: lines[0].trim(), comment2: lines[1].trim(), n_atoms, origin, dims, voxel_axes, atoms },
    orbital: raw_n_atoms < 0,
  }
}

/** Parse atom and grid geometry without reading the volumetric payload. */
export function parse_cube_header(text: string): ParsedCubeHeader {
  const { atoms, n_atoms, origin, dims, voxel_axes } = read_cube_header(text.split(`\n`)).header
  return { atoms, n_atoms, origin, dims, voxel_axes, is_angstrom: false }
}

/**
 * Convert grid indices (fractional) to Cartesian coordinates (Angstroms).
 * Matches Rust CubeFile::grid_to_cart.
 */
export function grid_to_cart(
  origin: [number, number, number],
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
  ix: number,
  iy: number,
  iz: number,
): [number, number, number] {
  return [
    origin[0] + ix * voxel_axes[0][0] + iy * voxel_axes[1][0] + iz * voxel_axes[2][0],
    origin[1] + ix * voxel_axes[0][1] + iy * voxel_axes[1][1] + iz * voxel_axes[2][1],
    origin[2] + ix * voxel_axes[0][2] + iy * voxel_axes[1][2] + iz * voxel_axes[2][2],
  ]
}

/**
 * Parse a complete Gaussian cube file including volumetric data.
 * Returns a CubeHeader (matching the server API type) and a VolumetricGrid.
 */
export function parse_cube_full(text: string): ParsedCubeData {
  const lines = text.split(`\n`)
  const { header, orbital } = read_cube_header(lines)
  const { dims, origin, voxel_axes } = header
  const total_voxels = dims[0] * dims[1] * dims[2]
  // Even one character per voxel would exceed the available input. Check
  // before allocation so a corrupt header cannot reserve an enormous array.
  if (total_voxels > text.length) throw new Error(`Insufficient Cube voxel data`)
  const data = new Float32Array(total_voxels)
  let data_idx = 0
  let data_min = Infinity
  let data_max = -Infinity
  let orbital_fields = orbital ? 2 : 0

  for (let li = 6 + header.n_atoms; li < lines.length; li++) {
    if (!lines[li].trim()) continue
    for (const token of lines[li].trim().split(/\s+/u)) {
      if (orbital_fields > 0) {
        const value = cube_integer(token, `orbital record`)
        if (orbital_fields === 2 && value !== 1) {
          throw new Error(`Multiple Cube orbital datasets are not supported`)
        }
        orbital_fields--
        continue
      }
      if (data_idx === total_voxels) throw new Error(`Too many Cube voxel values`)
      const value = Math.fround(cube_number(token, `voxel value`))
      if (!Number.isFinite(value)) throw new Error(`Cube voxel value exceeds Float32 range`)
      data[data_idx++] = value
      data_min = Math.min(data_min, value)
      data_max = Math.max(data_max, value)
    }
  }
  if (orbital_fields || data_idx !== total_voxels) {
    throw new Error(`Expected ${total_voxels} voxels but got ${data_idx}`)
  }
  return { header, grid: { data, dims, origin, voxel_axes, data_min, data_max } }
}

/**
 * Derive the real-space cell (lattice) from a cube grid.
 *
 * The cube grid spans one full period of the cell: lattice vector i is the
 * per-voxel axis vector i times the grid count along axis i. `voxel_axes` is
 * already in Angstrom (the parser applies the Bohr→Å conversion),
 * so the returned matrix is in Angstrom. Rows are the a, b, c lattice vectors.
 *
 * NOTE: this is only physically meaningful for files whose grid encodes a real
 * periodic cell (VASP CHGCAR/LOCPOT/ELFCAR/… family). For molecular Gaussian
 * cubes the grid is a padded bounding box, not a cell — callers must NOT treat
 * those as periodic. Periodicity is decided by source format at the load entry
 * point, not here.
 */
export function derive_cube_lattice(
  dims: [number, number, number],
  voxel_axes: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
): Matrix3x3 {
  return [
    [
      voxel_axes[0][0] * dims[0],
      voxel_axes[0][1] * dims[0],
      voxel_axes[0][2] * dims[0],
    ],
    [
      voxel_axes[1][0] * dims[1],
      voxel_axes[1][1] * dims[1],
      voxel_axes[1][2] * dims[1],
    ],
    [
      voxel_axes[2][0] * dims[2],
      voxel_axes[2][1] * dims[2],
      voxel_axes[2][2] * dims[2],
    ],
  ]
}

/** Build a full pymatgen-style lattice (matrix + pbc + params + volume). */
function build_lattice(matrix: Matrix3x3): PymatgenLattice {
  const params = calc_lattice_params(matrix)
  const pbc: Pbc = [true, true, true]
  return { matrix, pbc, ...params }
}

/**
 * Convert parsed cube atoms to a structure for the 3D viewer.
 *
 * - `periodic: false` (default, molecular Gaussian cubes): returns a bare
 *   `PymatgenMolecule` with NO lattice — renders as a finite cluster, exactly
 *   as before. `abc` is left at [0,0,0].
 * - `periodic: true` (VASP charge densities — CHGCAR/CHGDIFF/LOCPOT/ELFCAR/
 *   PARCHG/AECCAR/*.vasp): derives the cell from the cube grid and returns a
 *   `PymatgenStructure` with a real lattice (matrix + pbc=[true,true,true]) and
 *   fractional `abc` per site, so the viewer draws the unit-cell box and
 *   PBC cross-cell bonds via the normal periodic-structure machinery.
 */
export function cube_atoms_to_molecule(
  header: ParsedCubeHeader,
  opts: { periodic?: boolean } = {},
): PymatgenMolecule & { lattice?: PymatgenLattice } {
  const periodic = opts.periodic === true
  const lattice = periodic
    ? build_lattice(derive_cube_lattice(header.dims, header.voxel_axes))
    : undefined

  // The unit-cell box is drawn from the world origin (Lattice.svelte renders
  // it at vector_origin = [0,0,0], spanning the matrix). The cube grid, though,
  // is anchored at `header.origin` — for a real periodic cube the cell occupies
  // [origin, origin + Σ lattice vectors], NOT [0, cell]. Express atom positions
  // RELATIVE to that origin so the atoms sit inside the rendered box (and their
  // fractional `abc` lands in [0,1]). For the CHGCAR→cube path the converter
  // writes origin = (0,0,0), so this subtraction is a no-op there; it only
  // matters for cubes that carry a non-zero grid origin.
  const [ox, oy, oz] = periodic ? header.origin : [0, 0, 0]
  const sites: Site[] = header.atoms.map((atom) => {
    const symbol = (
      atom.atomic_number > 0 && atom.atomic_number <= elem_symbols.length
        ? elem_symbols[atom.atomic_number - 1]
        : `X`
    ) as ElementSymbol

    const xyz: Vec3 = lattice
      ? [atom.position[0] - ox, atom.position[1] - oy, atom.position[2] - oz]
      : (atom.position as Vec3)
    const abc: Vec3 = lattice
      ? cartesian_to_fractional(xyz, lattice.matrix)
      : [0, 0, 0]

    return {
      species: [{ element: symbol, occu: 1, oxidation_state: 0 }],
      xyz,
      abc,
      label: symbol,
      properties: {} as Record<string, unknown>,
    }
  })

  // Single (non-union) return type so callers' `{ ...mol, _aligned } as
  // AnyStructure` cast keeps working. The `lattice` KEY is only attached when
  // periodic — a molecular cube returns a bare `{ sites }` exactly as before,
  // so the many bare `'lattice' in structure` guards across the app keep
  // treating it as a non-periodic molecule.
  const result: PymatgenMolecule & { lattice?: PymatgenLattice } = { sites }
  if (lattice) result.lattice = lattice
  return result
}
