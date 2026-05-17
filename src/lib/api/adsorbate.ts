import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL } from './config'

function format_error_detail(detail: unknown): string {
  if (typeof detail === `string`) return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === `object` && d?.msg) {
          const loc = Array.isArray(d.loc) ? d.loc.join(`.`) : ``
          return loc ? `${d.msg} (${loc})` : d.msg
        }
        return JSON.stringify(d)
      })
      .join(`; `)
  }
  return JSON.stringify(detail)
}

/** A preset adsorbate molecule with xyz coordinates and default binding atom.
 *
 * `formula` is the canonical ASCII formula (H2O, NH2NH2, …). It is what the
 * workflow engine looks up in its species library and what gets serialised to
 * MCP / backend payloads. `display_formula`, when present, is the pretty
 * Unicode-subscript variant (H₂O, NH₂NH₂, …) used for UI rendering only.
 */
export interface AdsorbatePreset {
  name: string
  formula: string
  display_formula?: string
  atoms: { symbol: string; position: [number, number, number] }[]
  default_binding_index: number
  group?: string
}

/** Grouped adsorbate presets for electrocatalysis screening.
 *
 * Single source of truth: `server/data/adsorbates.json`. The same JSON is
 * loaded by the Python workflow engine and by the MCP `list_presets` action,
 * so adding a species in one place propagates to all surfaces.
 */
import ADSORBATE_DATA from '../../../server/data/adsorbates.json'

type RawPreset = {
  name: string
  formula: string
  display_formula?: string
  atoms: { symbol: string; position: number[] }[]
  default_binding_index: number
}
type RawGroup = { label: string; presets: RawPreset[] }
const _RAW_GROUPS = (ADSORBATE_DATA as { groups: RawGroup[] }).groups

export const ADSORBATE_PRESET_GROUPS: { label: string; presets: AdsorbatePreset[] }[] =
  _RAW_GROUPS.map((g) => ({
    label: g.label,
    presets: g.presets.map((p) => ({
      name: p.name,
      formula: p.formula,
      display_formula: p.display_formula,
      atoms: p.atoms.map((a) => ({
        symbol: a.symbol,
        position: [a.position[0], a.position[1], a.position[2]] as [number, number, number],
      })),
      default_binding_index: p.default_binding_index,
      group: g.label,
    })),
  }))


/** Flat list of all presets (for backward compatibility). */
export const ADSORBATE_PRESETS: AdsorbatePreset[] = ADSORBATE_PRESET_GROUPS.flatMap(g => g.presets)

export interface AdsorbatePlacementRequest {
  slab: PymatgenStructure
  adsorbate: PymatgenStructure
  binding_atom_indices: number[]
  site_position: [number, number, number]
  site_normal: [number, number, number]
  neighbor_positions?: [number, number, number][]
  height_offset?: number
  auto_rotate?: boolean
}

export interface AdsorbatePlacementResult {
  structure: PymatgenStructure
  slab_atom_count: number
  adsorbate_atom_count: number
  adsorbate_indices: number[]
  binding_atom_position: [number, number, number]
  message: string
}

/** Convert an AdsorbatePreset to a PymatgenStructure (molecule without lattice). */
export function preset_to_structure(preset: AdsorbatePreset): PymatgenStructure {
  return {
    sites: preset.atoms.map((atom) => ({
      species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
      abc: atom.position as [number, number, number],
      xyz: atom.position as [number, number, number],
      label: atom.symbol,
      properties: {},
    })),
    lattice: {
      matrix: [
        [10, 0, 0],
        [0, 10, 0],
        [0, 0, 10],
      ],
      pbc: [false, false, false],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
  } as PymatgenStructure
}

/** Call the backend to place an adsorbate at a surface site. */
export async function placeAdsorbate(
  request: AdsorbatePlacementRequest,
  server_url = SERVER_URL,
): Promise<AdsorbatePlacementResult> {
  const response = await fetch(`${server_url}/api/adsorption/place`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

// ─── Pure TypeScript placement (no backend) ──────────────────────────────────

type Vec3 = [number, number, number]

/** Invert a 3×3 matrix (rows are lattice vectors). */
function mat3_inverse(m: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) throw new Error(`Singular lattice matrix`)
  const inv = 1 / det
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ]
}

/** Convert Cartesian → fractional using inverse lattice matrix. */
function cart_to_frac(xyz: Vec3, inv_m: [Vec3, Vec3, Vec3]): Vec3 {
  return [
    xyz[0] * inv_m[0][0] + xyz[1] * inv_m[1][0] + xyz[2] * inv_m[2][0],
    xyz[0] * inv_m[0][1] + xyz[1] * inv_m[1][1] + xyz[2] * inv_m[2][1],
    xyz[0] * inv_m[0][2] + xyz[1] * inv_m[1][2] + xyz[2] * inv_m[2][2],
  ]
}

/** Rotate a set of 3D vectors so that `from_dir` maps to `to_dir` (both normalised first). */
function rotate_vectors(points: Vec3[], from_dir: Vec3, to_dir: Vec3): Vec3[] {
  const norm = (v: Vec3) => {
    const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    return len < 1e-12 ? ([0, 0, 1] as Vec3) : ([v[0] / len, v[1] / len, v[2] / len] as Vec3)
  }
  const s = norm(from_dir)
  const t = norm(to_dir)
  const dot = s[0] * t[0] + s[1] * t[1] + s[2] * t[2]
  if (dot > 1 - 1e-9) return points // already aligned
  if (dot < -1 + 1e-9) {
    // 180° flip around x-axis
    return points.map((p) => [-p[0], -p[1], -p[2]] as Vec3)
  }
  // Rodrigues rotation
  const ax = norm([s[1] * t[2] - s[2] * t[1], s[2] * t[0] - s[0] * t[2], s[0] * t[1] - s[1] * t[0]])
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
  const c = Math.cos(angle)
  const ss = Math.sin(angle)
  const tc = 1 - c
  const [ax0, ax1, ax2] = ax
  const R: [Vec3, Vec3, Vec3] = [
    [tc * ax0 * ax0 + c,           tc * ax0 * ax1 - ss * ax2, tc * ax0 * ax2 + ss * ax1],
    [tc * ax0 * ax1 + ss * ax2,    tc * ax1 * ax1 + c,        tc * ax1 * ax2 - ss * ax0],
    [tc * ax0 * ax2 - ss * ax1,    tc * ax1 * ax2 + ss * ax0, tc * ax2 * ax2 + c],
  ]
  return points.map((p) => [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
  ] as Vec3)
}

/**
 * Place an adsorbate at a surface site — pure TypeScript, no backend required.
 *
 * Algorithm:
 *  1. Translate molecule so binding centroid is at origin
 *  2. If auto_rotate: rotate molecule axis ([0,0,1]) to align with site_normal
 *  3. Translate binding atom to site_position + height_offset * normal
 *  4. Merge with slab and return combined structure
 */
export function place_adsorbate_local(
  slab: PymatgenStructure,
  adsorbate_atoms: { symbol: string; position: Vec3 }[],
  binding_atom_indices: number[],
  site_position: Vec3,
  site_normal: Vec3,
  height_offset: number,
  auto_rotate: boolean,
): AdsorbatePlacementResult {
  if (adsorbate_atoms.length === 0) throw new Error(`No adsorbate atoms provided`)

  // Normalize site normal
  const n_len = Math.sqrt(site_normal[0] ** 2 + site_normal[1] ** 2 + site_normal[2] ** 2)
  const n: Vec3 = n_len < 1e-9 ? [0, 0, 1] : [site_normal[0] / n_len, site_normal[1] / n_len, site_normal[2] / n_len]

  // Compute binding centroid
  const valid_binding = binding_atom_indices.filter((i) => i < adsorbate_atoms.length)
  const bi = valid_binding.length > 0 ? valid_binding : [0]
  const binding_c: Vec3 = [
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[0], 0) / bi.length,
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[1], 0) / bi.length,
    bi.reduce((s, i) => s + adsorbate_atoms[i].position[2], 0) / bi.length,
  ]

  // Center molecule at binding centroid
  let positions: Vec3[] = adsorbate_atoms.map((a) => [
    a.position[0] - binding_c[0],
    a.position[1] - binding_c[1],
    a.position[2] - binding_c[2],
  ] as Vec3)

  // Rotate molecule so its natural axis ([0,0,1]) aligns with surface normal
  if (auto_rotate) {
    positions = rotate_vectors(positions, [0, 0, 1], n)
  }

  // Translate to final position: site + height_offset along normal
  const target: Vec3 = [
    site_position[0] + height_offset * n[0],
    site_position[1] + height_offset * n[1],
    site_position[2] + height_offset * n[2],
  ]
  let final_positions: Vec3[] = positions.map((p) => [p[0] + target[0], p[1] + target[1], p[2] + target[2]] as Vec3)

  // --- Overlap detection: push adsorbate up along normal if too close to slab ---
  const OVERLAP_FACTOR = 0.7 // fraction of sum of covalent radii considered overlap
  const NUDGE_STEP = 0.2 // Å per step
  const MAX_NUDGES = 20
  // Covalent radii for common elements (Å)
  const COV_R: Record<string, number> = {
    H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66,
    F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05,
    Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39,
    Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19,
    Se: 1.20, Br: 1.20, Zr: 1.75, Nb: 1.64, Mo: 1.54, Ru: 1.46, Rh: 1.42, Pd: 1.39,
    Ag: 1.45, Pt: 1.36, Au: 1.36, Ir: 1.41, Os: 1.44, W: 1.62, Ta: 1.70, Hf: 1.75,
  }
  function cov_r(sym: string): number { return COV_R[sym] ?? 1.5 }

  for (let nudge = 0; nudge < MAX_NUDGES; nudge++) {
    let has_overlap = false
    for (let ai = 0; ai < final_positions.length; ai++) {
      const fp = final_positions[ai]
      const ads_sym = adsorbate_atoms[ai]?.symbol ?? `C`
      for (const slab_site of slab.sites) {
        const sxyz = slab_site.xyz ?? slab_site.abc
        if (!sxyz) continue
        const dx = fp[0] - sxyz[0], dy = fp[1] - sxyz[1], dz = fp[2] - sxyz[2]
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const slab_sym = slab_site.species?.[0]?.element ?? slab_site.label ?? `X`
        const min_dist = (cov_r(ads_sym) + cov_r(slab_sym)) * OVERLAP_FACTOR
        if (dist < min_dist) { has_overlap = true; break }
      }
      if (has_overlap) break
    }
    if (!has_overlap) break
    // Push all adsorbate atoms up along surface normal
    final_positions = final_positions.map((p) => [
      p[0] + NUDGE_STEP * n[0],
      p[1] + NUDGE_STEP * n[1],
      p[2] + NUDGE_STEP * n[2],
    ] as Vec3)
  }

  // Compute fractional coordinates for adsorbate atoms using slab lattice
  const lat = slab.lattice?.matrix as [Vec3, Vec3, Vec3] | undefined
  const inv_lat = lat ? mat3_inverse(lat) : null

  const slab_count = slab.sites.length
  const merged_sites = [
    ...slab.sites,
    ...adsorbate_atoms.map((atom, i) => {
      const xyz = final_positions[i]
      const abc = inv_lat ? cart_to_frac(xyz, inv_lat) : xyz
      return {
        species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
        abc,
        xyz,
        label: atom.symbol,
        properties: {} as Record<string, unknown>,
      }
    }),
  ]

  const binding_atom_position = final_positions[bi[0]]

  return {
    structure: { ...slab, sites: merged_sites } as PymatgenStructure,
    slab_atom_count: slab_count,
    adsorbate_atom_count: adsorbate_atoms.length,
    adsorbate_indices: adsorbate_atoms.map((_, i) => slab_count + i),
    binding_atom_position,
    message: `Placed ${adsorbate_atoms.length}-atom adsorbate at site`,
  }
}
