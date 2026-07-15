/**
 * Pure geometry baking for the "Render Still" offline path tracer.
 *
 * The live viewer draws atoms as billboard impostors (AtomManagerInstances)
 * and bonds as instanced half-cylinders — neither survives
 * three-gpu-pathtracer's PathTracingSceneGenerator (it does not expand
 * InstancedMesh and cannot evaluate custom ShaderMaterials). So we re-bake
 * the displayed structure from its SoA buffers into plain merged indexed
 * triangle arrays that a MeshStandardMaterial(vertexColors) can represent.
 *
 * Everything in this file is WebGL-free and deterministic → unit-testable.
 *
 * Conventions (match the live renderers exactly):
 *   - All per-site arrays are SITE-indexed (same indexing the bond pairs use).
 *   - Colors are LINEAR-rgb triples (the working color space of the scene).
 *   - Cross-cell bonds: partner B sits at `b_eff = pos_b + lattice·jimage`
 *     where `lattice` rows are the a, b, c vectors (pymatgen convention) —
 *     same math as bond-instanced-renderer.ts.
 *   - Each bond is TWO solid-colored half cylinders meeting at the midpoint
 *     of the (a, b_eff) segment (hard color split, not a gradient).
 */
import { Quaternion, Vector3 } from 'three'

/** Snapshot of the displayed structure, read from the viewer's SoA managers. */
export interface RenderStillSource {
  /** xyz per site, length 3 * site_count (displayed frame positions) */
  positions: Float32Array
  /** linear-rgb per site, length 3 * site_count; null → neutral gray */
  colors: Float32Array | null
  /** radius per site, length site_count; <= 0 marks a hidden site */
  radii: Float32Array
  site_count: number
  /** interleaved [a0, b0, a1, b1, ...] site indices, 2 per bond */
  bond_pairs: Uint32Array
  /** interleaved [dx, dy, dz, ...] per bond, applied to end B */
  bond_jimages: Int8Array
  /** BOND_KIND byte per bond (0 = auto, 1 = manual, 2 = hbond, 3 = halo) */
  bond_kinds: Uint8Array
  bond_count: number
  /** row-major 3x3, rows are lattice vectors a, b, c; null for molecules */
  lattice: Float64Array | null
  /** cylinder radius in Å (the viewer's bond_thickness) */
  bond_radius: number
}

/** Unit template mesh (indexed triangles) to be stamped per atom / half-bond. */
export interface TemplateMesh {
  position: Float32Array
  normal: Float32Array
  index: Uint32Array
}

/** Merged output arrays, ready to become a three BufferGeometry. */
export interface BakedArrays {
  position: Float32Array
  normal: Float32Array
  color: Float32Array
  index: Uint32Array
}

/** Bond kinds that bake as solid cylinders (auto + manual). H-bonds are dashed
 *  overlays and halo bonds are selection chrome — neither belongs in a still. */
const SOLID_BOND_KINDS = new Set([0, 1])

const FALLBACK_GRAY = 0.55

/**
 * Stamp one unit sphere per visible site (radius > 0), scaled by the site
 * radius, translated to the site position, vertex-colored with the site's
 * linear-rgb color. Returns null when nothing is visible.
 */
export function bake_atoms(
  src: RenderStillSource,
  tmpl: TemplateMesh,
): BakedArrays | null {
  const { positions, colors, radii, site_count } = src
  let n_visible = 0
  for (let idx = 0; idx < site_count; idx++) if (radii[idx] > 0) n_visible++
  if (n_visible === 0) return null

  const vc = tmpl.position.length / 3
  const ic = tmpl.index.length
  const out: BakedArrays = {
    position: new Float32Array(n_visible * vc * 3),
    normal: new Float32Array(n_visible * vc * 3),
    color: new Float32Array(n_visible * vc * 3),
    index: new Uint32Array(n_visible * ic),
  }

  let written = 0
  for (let site = 0; site < site_count; site++) {
    const r = radii[site]
    if (r <= 0) continue
    const ox = positions[site * 3]
    const oy = positions[site * 3 + 1]
    const oz = positions[site * 3 + 2]
    const cr = colors ? colors[site * 3] : FALLBACK_GRAY
    const cg = colors ? colors[site * 3 + 1] : FALLBACK_GRAY
    const cb = colors ? colors[site * 3 + 2] : FALLBACK_GRAY
    const vb = written * vc * 3
    for (let j = 0; j < vc; j++) {
      out.position[vb + j * 3] = tmpl.position[j * 3] * r + ox
      out.position[vb + j * 3 + 1] = tmpl.position[j * 3 + 1] * r + oy
      out.position[vb + j * 3 + 2] = tmpl.position[j * 3 + 2] * r + oz
      // uniform scale + translation → normals are the template's, unchanged
      out.normal[vb + j * 3] = tmpl.normal[j * 3]
      out.normal[vb + j * 3 + 1] = tmpl.normal[j * 3 + 1]
      out.normal[vb + j * 3 + 2] = tmpl.normal[j * 3 + 2]
      out.color[vb + j * 3] = cr
      out.color[vb + j * 3 + 1] = cg
      out.color[vb + j * 3 + 2] = cb
    }
    const ib = written * ic
    const voff = written * vc
    for (let j = 0; j < ic; j++) out.index[ib + j] = tmpl.index[j] + voff
    written++
  }
  return out
}

const UP_Y = new Vector3(0, 1, 0)

/**
 * Stamp two solid-colored half cylinders per solid bond (auto/manual kinds
 * whose endpoints are both visible). The template must be a unit cylinder:
 * radius 1, height 1, axis +y, centered at the origin, open-ended (radial
 * normals with zero y-component, so rotation alone transforms them
 * correctly under the anisotropic radius/length scaling).
 */
export function bake_bonds(
  src: RenderStillSource,
  tmpl: TemplateMesh,
): BakedArrays | null {
  const {
    positions,
    colors,
    radii,
    bond_pairs,
    bond_jimages,
    bond_kinds,
    bond_count,
    lattice,
    bond_radius,
  } = src

  // First pass: count halves so the output arrays are exact-fit.
  let n_halves = 0
  for (let bond = 0; bond < bond_count; bond++) {
    if (!SOLID_BOND_KINDS.has(bond_kinds[bond])) continue
    const site_a = bond_pairs[bond * 2]
    const site_b = bond_pairs[bond * 2 + 1]
    if (radii[site_a] <= 0 || radii[site_b] <= 0) continue
    n_halves += 2
  }
  if (n_halves === 0) return null

  const vc = tmpl.position.length / 3
  const ic = tmpl.index.length
  const out: BakedArrays = {
    position: new Float32Array(n_halves * vc * 3),
    normal: new Float32Array(n_halves * vc * 3),
    color: new Float32Array(n_halves * vc * 3),
    index: new Uint32Array(n_halves * ic),
  }

  const q = new Quaternion()
  const dir = new Vector3()
  const v = new Vector3()

  let written = 0
  const write_half = (
    cx: number,
    cy: number,
    cz: number,
    half_len: number,
    color_site: number,
  ): void => {
    const cr = colors ? colors[color_site * 3] : FALLBACK_GRAY
    const cg = colors ? colors[color_site * 3 + 1] : FALLBACK_GRAY
    const cb = colors ? colors[color_site * 3 + 2] : FALLBACK_GRAY
    const vb = written * vc * 3
    for (let j = 0; j < vc; j++) {
      v.set(
        tmpl.position[j * 3] * bond_radius,
        tmpl.position[j * 3 + 1] * half_len,
        tmpl.position[j * 3 + 2] * bond_radius,
      ).applyQuaternion(q)
      out.position[vb + j * 3] = v.x + cx
      out.position[vb + j * 3 + 1] = v.y + cy
      out.position[vb + j * 3 + 2] = v.z + cz
      v.set(tmpl.normal[j * 3], tmpl.normal[j * 3 + 1], tmpl.normal[j * 3 + 2])
        .applyQuaternion(q)
      out.normal[vb + j * 3] = v.x
      out.normal[vb + j * 3 + 1] = v.y
      out.normal[vb + j * 3 + 2] = v.z
      out.color[vb + j * 3] = cr
      out.color[vb + j * 3 + 1] = cg
      out.color[vb + j * 3 + 2] = cb
    }
    const ib = written * ic
    const voff = written * vc
    for (let j = 0; j < ic; j++) out.index[ib + j] = tmpl.index[j] + voff
    written++
  }

  for (let bond = 0; bond < bond_count; bond++) {
    if (!SOLID_BOND_KINDS.has(bond_kinds[bond])) continue
    const site_a = bond_pairs[bond * 2]
    const site_b = bond_pairs[bond * 2 + 1]
    if (radii[site_a] <= 0 || radii[site_b] <= 0) continue

    const ax = positions[site_a * 3]
    const ay = positions[site_a * 3 + 1]
    const az = positions[site_a * 3 + 2]
    let bx = positions[site_b * 3]
    let by = positions[site_b * 3 + 1]
    let bz = positions[site_b * 3 + 2]

    const dx = bond_jimages[bond * 3]
    const dy = bond_jimages[bond * 3 + 1]
    const dz = bond_jimages[bond * 3 + 2]
    if ((dx | dy | dz) !== 0 && lattice !== null) {
      // b_eff = pos_b + dx·a_vec + dy·b_vec + dz·c_vec (rows of the lattice)
      bx += dx * lattice[0] + dy * lattice[3] + dz * lattice[6]
      by += dx * lattice[1] + dy * lattice[4] + dz * lattice[7]
      bz += dx * lattice[2] + dy * lattice[5] + dz * lattice[8]
    }

    const fx = bx - ax
    const fy = by - ay
    const fz = bz - az
    const len = Math.sqrt(fx * fx + fy * fy + fz * fz)
    if (len < 1e-6) continue
    dir.set(fx / len, fy / len, fz / len)
    q.setFromUnitVectors(UP_Y, dir)

    // half A: spans a → midpoint, solid-colored by site A
    write_half(ax + fx * 0.25, ay + fy * 0.25, az + fz * 0.25, len * 0.5, site_a)
    // half B: spans midpoint → b_eff, solid-colored by site B
    write_half(ax + fx * 0.75, ay + fy * 0.75, az + fz * 0.75, len * 0.5, site_b)
  }

  // A degenerate (len < 1e-6) bond passed the count pass but was skipped in
  // the write pass — trim the arrays so index/vertex counts stay consistent.
  if (written < n_halves) {
    return {
      position: out.position.slice(0, written * vc * 3),
      normal: out.normal.slice(0, written * vc * 3),
      color: out.color.slice(0, written * vc * 3),
      index: out.index.slice(0, written * ic),
    }
  }
  return out
}
