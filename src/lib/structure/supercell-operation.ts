/**
 * Canonical PURE executor for the "true" Build → Lattice → Supercell edit.
 *
 * This is the explicit operation channel from the trajectory-supercell design
 * (§9.1 / §9.4). It is deliberately free of Svelte / worker / trajectory
 * wiring: it validates an integer transform against a source frame, materializes
 * the supercell, and records immutable provenance. Renderer state such as
 * `large_system_mode` MUST NOT reach this module — Build semantics never depend
 * on which renderer is active.
 *
 * The supercell math is backed by `build_supercell_frame` in `lattice-ops.ts`;
 * this module adds validation, provenance, charge scaling, and optional
 * reorientation (which rotates Cartesian vector site properties consistently
 * with positions and lattice).
 */
import type { Matrix3x3, Vec3 } from '$lib/math'
import * as math from '$lib/math'
import type { PymatgenLattice, PymatgenStructure, Site } from './index'
import { build_supercell_frame, compute_reorient_rotation } from './lattice-ops'

/** Row-major 3×3 integer transformation matrix (immutable). */
export type IntMatrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
]

/** An explicit true-supercell edit request (design §9.1). */
export type SupercellOp = {
  kind: 'supercell'
  matrix: IntMatrix3
  reorient: boolean
}

/**
 * Result of routing a supercell request through a pane's scope callback
 * (design §9.1). Produced by later Svelte/trajectory tasks, not by this pure
 * module — exported here so it has a single canonical definition.
 */
export type SupercellRequestResult =
  | { status: 'applied'; history_token: string }
  | { status: 'rejected'; message: string }
  | { status: 'stale' }

/**
 * Default hard ceiling on the predicted materialized atom count. Guards against
 * pathological transforms (e.g. a fat-fingered 1000×1000×1000). A true supercell
 * fully materializes JavaScript sites, so this is a real allocation budget, not
 * the GPU visual-instance ceiling.
 */
export const TRUE_SUPERCELL_MAX_ATOMS = 2_000_000

/**
 * Immutable provenance recorded for every successful supercell execution
 * (design §9.4). While this remains valid the renderer may keep the
 * pre-operation base topology plus a `physical-distinct-sites` replica layout
 * and lift base bonds on the GPU, so the map must stay authoritative.
 */
export type SupercellProvenance = {
  /** Identity of the source frame this supercell was materialized from (null if untracked). */
  source_frame_id: string | null
  /** Atom count of the source (base) frame. */
  source_atom_count: number
  /** The integer transformation matrix that was applied. */
  matrix: IntMatrix3
  /** Whether the result was reoriented into the standard frame. */
  reorient: boolean
  /** Number of replicated cells === |det(matrix)|. */
  cell_count: number
  /** Deterministic integer old-lattice offsets, one per cell. */
  cell_order: readonly Vec3[]
  /**
   * Flat `(base_site, cell) → physical_site` map:
   * `physical_site_map[cell_index * source_atom_count + base_site]` is the index
   * of the corresponding physical site in the output structure.
   */
  physical_site_map: Uint32Array
}

/** Staged result of a supercell execution: the new structure plus provenance. */
export type SupercellExecution = {
  structure: PymatgenStructure
  provenance: SupercellProvenance
}

/** Discriminated validation outcome (design §9.4 rules). */
export type SupercellValidation =
  | { ok: true; det: number; predicted_count: number }
  | { ok: false; message: string }

/**
 * Site property keys whose values are Cartesian vectors and must rotate with the
 * lattice under reorientation. Scalar magmoms (a bare number) and boolean flags
 * such as `selective_dynamics` are intentionally excluded.
 */
const CARTESIAN_VECTOR_PROPERTY_KEYS = new Set([
  'force',
  'forces',
  'magmom',
  'magnetic_moment',
  'magmom_vector',
  'velocity',
  'velocities',
])

/** Copy a readonly IntMatrix3 into the mutable tuple the lattice-ops math expects. */
function to_mutable_matrix(
  m: IntMatrix3,
): [[number, number, number], [number, number, number], [number, number, number]] {
  return [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ]
}

function is_finite_integer(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x)
}

/**
 * Validate a supercell request against a source frame (design §9.4). Never
 * mutates or materializes anything — the predicted count is checked before any
 * allocation, so an oversized transform is rejected cheaply.
 */
export function validate_supercell_op(
  structure: Pick<PymatgenStructure, 'sites'> & { lattice?: PymatgenLattice },
  op: SupercellOp,
  max_atoms: number = TRUE_SUPERCELL_MAX_ATOMS,
): SupercellValidation {
  const matrix = op?.matrix as unknown

  // 3×3 shape.
  if (
    !Array.isArray(matrix) || matrix.length !== 3 ||
    matrix.some((row) => !Array.isArray(row) || row.length !== 3)
  ) {
    return { ok: false, message: `Supercell matrix must be a 3×3 array` }
  }

  // Finite integer entries.
  for (const row of matrix as number[][]) {
    for (const value of row) {
      if (!is_finite_integer(value)) {
        return {
          ok: false,
          message: `Supercell matrix must contain only finite integers (got ${value})`,
        }
      }
    }
  }

  // Source frame must have a lattice.
  const lattice = structure?.lattice
  if (!lattice?.matrix || lattice.matrix.length !== 3) {
    return {
      ok: false,
      message: `Source frame has no lattice; a supercell requires a periodic cell`,
    }
  }

  // Non-zero determinant.
  const det = Math.round(math.det_3x3(to_mutable_matrix(op.matrix) as Matrix3x3))
  if (!Number.isFinite(det) || det === 0) {
    return { ok: false, message: `Supercell matrix is singular (determinant 0)` }
  }

  // Output count === N × |det|, within the explicit limit.
  const n = structure.sites?.length ?? 0
  const predicted_count = n * Math.abs(det)
  if (predicted_count > max_atoms) {
    return {
      ok: false,
      message:
        `Predicted supercell atom count ${predicted_count} exceeds limit ${max_atoms}`,
    }
  }

  return { ok: true, det, predicted_count }
}

/** Rotate a site's position and any Cartesian vector properties by `rot`. */
function reorient_site(site: Site, rot: Matrix3x3): Site {
  const xyz = math.mat3x3_vec3_multiply(rot, site.xyz)

  let properties = site.properties
  let cloned: Record<string, unknown> | null = null
  for (const key of Object.keys(properties)) {
    if (!CARTESIAN_VECTOR_PROPERTY_KEYS.has(key)) continue
    const value = properties[key]
    if (
      Array.isArray(value) && value.length === 3 &&
      value.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      if (!cloned) cloned = { ...properties }
      cloned[key] = math.mat3x3_vec3_multiply(rot, value as Vec3)
    }
  }
  if (cloned) properties = cloned

  // Fractional coords are invariant under a rigid rotation of cell + positions.
  return { ...site, xyz, properties }
}

/**
 * Execute a validated supercell operation synchronously and return the new
 * structure plus immutable provenance (design §9.4). Throws — without mutating
 * `structure` — when validation fails, so a caller preserves its last complete
 * scene. Each call uses only the passed frame's own lattice, sites, and atom
 * count.
 *
 * Handedness: a negative-determinant transform deliberately produces a
 * left-handed output lattice. §9.4 requires only a non-zero determinant, so no
 * right-handing (a/b swap) is applied here; consumers exporting to formats
 * that need right-handed cells (e.g. POSCAR) handle handedness downstream.
 */
export function execute_supercell_op_sync(
  structure: PymatgenStructure,
  op: SupercellOp,
  max_atoms: number = TRUE_SUPERCELL_MAX_ATOMS,
): SupercellExecution {
  const validation = validate_supercell_op(structure, op, max_atoms)
  if (!validation.ok) {
    throw new Error(`Supercell rejected: ${validation.message}`)
  }
  const det = validation.det

  const transform = to_mutable_matrix(op.matrix)
  const build = build_supercell_frame(structure, transform)

  // Defense-in-depth for the §9.4 invariant `output count === N × |det|`: if
  // cell enumeration ever disagrees with the determinant, reject cleanly (no
  // mutation, no partial result) instead of silently materializing a supercell
  // with a wrongly-sized cell_count / physical_site_map.
  if (build.cells.length !== Math.abs(det)) {
    throw new Error(
      `Supercell rejected: enumerated ${build.cells.length} cells but |det(matrix)| = ${
        Math.abs(det)
      }`,
    )
  }

  let new_matrix: Matrix3x3 = build.matrix
  let sites: Site[] = build.sites

  if (op.reorient) {
    const rot = compute_reorient_rotation(new_matrix)
    new_matrix = [
      math.mat3x3_vec3_multiply(rot, new_matrix[0]),
      math.mat3x3_vec3_multiply(rot, new_matrix[1]),
      math.mat3x3_vec3_multiply(rot, new_matrix[2]),
    ]
    sites = sites.map((site) => reorient_site(site, rot))
  }

  const params = math.calc_lattice_params(new_matrix)

  const provenance: SupercellProvenance = {
    source_frame_id: (structure as { id?: string }).id ?? null,
    source_atom_count: structure.sites.length,
    matrix: op.matrix,
    reorient: op.reorient,
    cell_count: build.cells.length,
    cell_order: build.cells.map((cell) => [cell[0], cell[1], cell[2]] as Vec3),
    physical_site_map: build.physical_site_map,
  }

  // Drop session-local electronic metadata: it describes the pre-edit material
  // and must not survive a structural edit.
  const { _electronic_props: _drop, ...rest } = structure
  void _drop

  const out_structure: PymatgenStructure = {
    ...rest,
    lattice: {
      ...structure.lattice,
      matrix: new_matrix,
      a: params.a,
      b: params.b,
      c: params.c,
      alpha: params.alpha,
      beta: params.beta,
      gamma: params.gamma,
      volume: params.volume,
    },
    sites,
    charge: structure.charge != null ? structure.charge * Math.abs(det) : structure.charge,
  }

  return { structure: out_structure, provenance }
}
