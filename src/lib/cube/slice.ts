/**
 * Client-side 2D slice sampling through volumetric cube data.
 * Supports multiple colormaps, atom projection with 3D sphere rendering,
 * and local-coordinate tilt via Rodrigues' rotation.
 */

import type { VolumetricGrid } from './parse-cube'

export type Vec3 = [number, number, number]

export interface SliceResult {
  data: Float64Array // sampled values, row-major [height * width]
  width: number
  height: number
  min: number
  max: number
  // Plane geometry info for atom projection
  u_vec: Vec3
  v_vec: Vec3
  normal: Vec3
  center: Vec3
  u_min: number
  u_max: number
  v_min: number
  v_max: number
}

export interface AtomSliceInfo {
  u: number // position in plane U coordinate
  v: number // position in plane V coordinate
  dist: number // signed distance from plane
  element: string
  radius: number // display radius in Angstroms
}

// ── Colormaps ────────────────────────────────────────────────────────

// Each colormap is an array of [t, r, g, b] stops where t ∈ [0,1]
export type ColormapName = 'RdBu' | 'Viridis' | 'Plasma' | 'Inferno' | 'Coolwarm' | 'BrBG' | 'Spectral'

type ColormapStop = [number, number, number, number] // [t, r, g, b]

export const COLORMAPS: Record<ColormapName, ColormapStop[]> = {
  // d3 interpolateRdBu 11-point
  RdBu: [
    [0.0, 103, 0, 31], [0.1, 178, 24, 43], [0.2, 214, 96, 77],
    [0.3, 244, 165, 130], [0.4, 253, 219, 199], [0.5, 247, 247, 247],
    [0.6, 209, 229, 240], [0.7, 146, 197, 222], [0.8, 67, 147, 195],
    [0.9, 33, 102, 172], [1.0, 5, 48, 97],
  ],
  Viridis: [
    [0.0, 68, 1, 84], [0.1, 72, 36, 117], [0.2, 65, 68, 135],
    [0.3, 53, 95, 141], [0.4, 42, 120, 142], [0.5, 33, 145, 140],
    [0.6, 34, 168, 132], [0.7, 68, 191, 112], [0.8, 122, 209, 81],
    [0.9, 189, 223, 38], [1.0, 253, 231, 37],
  ],
  Plasma: [
    [0.0, 13, 8, 135], [0.1, 75, 3, 161], [0.2, 125, 3, 168],
    [0.3, 168, 34, 150], [0.4, 203, 70, 121], [0.5, 229, 107, 93],
    [0.6, 248, 148, 65], [0.7, 253, 191, 39], [0.8, 240, 229, 30],
    [0.9, 221, 252, 60], [1.0, 240, 249, 33],
  ],
  Inferno: [
    [0.0, 0, 0, 4], [0.1, 22, 11, 57], [0.2, 66, 10, 104],
    [0.3, 106, 23, 110], [0.4, 147, 38, 103], [0.5, 188, 55, 84],
    [0.6, 221, 81, 58], [0.7, 243, 118, 27], [0.8, 252, 165, 10],
    [0.9, 246, 215, 70], [1.0, 252, 255, 164],
  ],
  Coolwarm: [
    [0.0, 59, 76, 192], [0.1, 98, 113, 209], [0.2, 137, 148, 222],
    [0.3, 170, 178, 231], [0.4, 201, 203, 232], [0.5, 221, 221, 221],
    [0.6, 230, 195, 195], [0.7, 228, 160, 155], [0.8, 219, 119, 108],
    [0.9, 203, 73, 60], [1.0, 180, 4, 38],
  ],
  BrBG: [
    [0.0, 84, 48, 5], [0.1, 140, 81, 10], [0.2, 191, 129, 45],
    [0.3, 223, 194, 125], [0.4, 246, 232, 195], [0.5, 245, 245, 245],
    [0.6, 199, 234, 229], [0.7, 128, 205, 193], [0.8, 53, 151, 143],
    [0.9, 1, 102, 94], [1.0, 0, 60, 48],
  ],
  Spectral: [
    [0.0, 158, 1, 66], [0.1, 213, 62, 79], [0.2, 244, 109, 67],
    [0.3, 253, 174, 97], [0.4, 254, 224, 139], [0.5, 255, 255, 191],
    [0.6, 230, 245, 152], [0.7, 171, 221, 164], [0.8, 102, 194, 165],
    [0.9, 50, 136, 189], [1.0, 94, 79, 162],
  ],
}

export const COLORMAP_NAMES = Object.keys(COLORMAPS) as ColormapName[]

/** Piecewise-linear interpolation through colormap stops. */
function sample_colormap(stops: ColormapStop[], t: number): [number, number, number] {
  if (t <= 0) return [stops[0][1], stops[0][2], stops[0][3]]
  if (t >= 1) {
    const last = stops[stops.length - 1]
    return [last[1], last[2], last[3]]
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])
      return [
        Math.round(stops[i - 1][1] + (stops[i][1] - stops[i - 1][1]) * f),
        Math.round(stops[i - 1][2] + (stops[i][2] - stops[i - 1][2]) * f),
        Math.round(stops[i - 1][3] + (stops[i][3] - stops[i - 1][3]) * f),
      ]
    }
  }
  const last = stops[stops.length - 1]
  return [last[1], last[2], last[3]]
}

/** Generate a CSS linear-gradient string for a colormap (for colorbar display). */
export function colormap_css_gradient(name: ColormapName, direction = `to bottom`): string {
  const stops = COLORMAPS[name]
  const parts = stops.map(([t, r, g, b]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`)
  return `linear-gradient(${direction}, ${parts.join(`, `)})`
}

// ── Math helpers ─────────────────────────────────────────────────────

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(...v)
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
}

/** Orthonormal in-plane basis via Gram-Schmidt. */
export function in_plane_basis(normal: Vec3): [Vec3, Vec3] {
  let ref_vec: Vec3 = [1, 0, 0]
  if (Math.abs(normal[0]) > 0.9) ref_vec = [0, 1, 0]

  const d = dot(normal, ref_vec)
  const u_raw: Vec3 = [
    ref_vec[0] - d * normal[0],
    ref_vec[1] - d * normal[1],
    ref_vec[2] - d * normal[2],
  ]
  const u = normalize(u_raw)
  const v = cross(normal, u)
  return [u, v]
}

/** Rodrigues' rotation: rotate `vec` around `axis` by `angle_rad`. */
export function rodrigues_rotate(vec: Vec3, axis: Vec3, angle_rad: number): Vec3 {
  const cos_a = Math.cos(angle_rad)
  const sin_a = Math.sin(angle_rad)
  const d = dot(axis, vec)
  const cr = cross(axis, vec)
  return [
    vec[0] * cos_a + cr[0] * sin_a + axis[0] * d * (1 - cos_a),
    vec[1] * cos_a + cr[1] * sin_a + axis[1] * d * (1 - cos_a),
    vec[2] * cos_a + cr[2] * sin_a + axis[2] * d * (1 - cos_a),
  ]
}

/** Invert 3×3 matrix (row-major: M[row][col]). */
function invert3(m: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const [[a, b, c], [d, e, f], [g, h, k]] = m
  const det =
    a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-30) throw new Error(`Singular voxel matrix`)
  const inv = 1 / det
  return [
    [(e * k - f * h) * inv, (c * h - b * k) * inv, (b * f - c * e) * inv],
    [(f * g - d * k) * inv, (a * k - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ]
}

// ── Trilinear interpolation ──────────────────────────────────────────

function trilinear(
  data: Float32Array,
  dims: Vec3,
  gx: number,
  gy: number,
  gz: number,
): number {
  const [nx, ny, nz] = dims
  if (gx < 0 || gx > nx - 1 || gy < 0 || gy > ny - 1 || gz < 0 || gz > nz - 1)
    return 0

  const x0 = Math.min(Math.floor(gx), nx - 2)
  const y0 = Math.min(Math.floor(gy), ny - 2)
  const z0 = Math.min(Math.floor(gz), nz - 2)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const z1 = z0 + 1
  const xd = gx - x0
  const yd = gy - y0
  const zd = gz - z0

  const s = ny * nz
  const c000 = data[x0 * s + y0 * nz + z0]
  const c001 = data[x0 * s + y0 * nz + z1]
  const c010 = data[x0 * s + y1 * nz + z0]
  const c011 = data[x0 * s + y1 * nz + z1]
  const c100 = data[x1 * s + y0 * nz + z0]
  const c101 = data[x1 * s + y0 * nz + z1]
  const c110 = data[x1 * s + y1 * nz + z0]
  const c111 = data[x1 * s + y1 * nz + z1]

  const c00 = c000 + (c100 - c000) * xd
  const c01 = c001 + (c101 - c001) * xd
  const c10 = c010 + (c110 - c010) * xd
  const c11 = c011 + (c111 - c011) * xd
  const c0 = c00 + (c10 - c00) * yd
  const c1 = c01 + (c11 - c01) * yd
  return c0 + (c1 - c0) * zd
}

// ── Plane slicing ────────────────────────────────────────────────────

/**
 * Sample a 2D slice through volumetric cube data at an arbitrary plane
 * defined by a Cartesian normal and center point.
 */
export function sample_plane_slice(
  grid: VolumetricGrid,
  normal: Vec3,
  center: Vec3,
): SliceResult | null {
  const unit_normal = normalize(normal)
  const [u_vec, v_vec] = in_plane_basis(unit_normal)

  const { data, dims, origin, voxel_axes } = grid
  const [nx, ny, nz] = dims

  // Transpose voxel_axes to get columns (cart = origin + Vt * grid_idx)
  const vt: [Vec3, Vec3, Vec3] = [
    [voxel_axes[0][0], voxel_axes[1][0], voxel_axes[2][0]],
    [voxel_axes[0][1], voxel_axes[1][1], voxel_axes[2][1]],
    [voxel_axes[0][2], voxel_axes[1][2], voxel_axes[2][2]],
  ]
  const vt_inv = invert3(vt)

  // Project all 8 grid corners onto the plane to find sampling bounds
  let u_min = Infinity, u_max = -Infinity
  let v_min = Infinity, v_max = -Infinity

  for (let ci = 0; ci < 8; ci++) {
    const fi = ci & 1 ? nx - 1 : 0
    const fj = ci & 2 ? ny - 1 : 0
    const fk = ci & 4 ? nz - 1 : 0
    const cx = origin[0] + fi * voxel_axes[0][0] + fj * voxel_axes[1][0] + fk * voxel_axes[2][0]
    const cy = origin[1] + fi * voxel_axes[0][1] + fj * voxel_axes[1][1] + fk * voxel_axes[2][1]
    const cz = origin[2] + fi * voxel_axes[0][2] + fj * voxel_axes[1][2] + fk * voxel_axes[2][2]
    const dx = cx - center[0], dy = cy - center[1], dz = cz - center[2]
    const u_proj = dx * u_vec[0] + dy * u_vec[1] + dz * u_vec[2]
    const v_proj = dx * v_vec[0] + dy * v_vec[1] + dz * v_vec[2]
    if (u_proj < u_min) u_min = u_proj
    if (u_proj > u_max) u_max = u_proj
    if (v_proj < v_min) v_min = v_proj
    if (v_proj > v_max) v_max = v_proj
  }

  const resolution = Math.max(nx, ny, nz)
  const width = resolution
  const height = resolution

  const slice_data = new Float64Array(width * height)
  let data_min = Infinity
  let data_max = -Infinity

  const u_step = (u_max - u_min) / (width - 1 || 1)
  const v_step = (v_max - v_min) / (height - 1 || 1)

  for (let row = 0; row < height; row++) {
    const v_val = v_min + row * v_step
    for (let col = 0; col < width; col++) {
      const u_val = u_min + col * u_step

      const px = center[0] + u_val * u_vec[0] + v_val * v_vec[0]
      const py = center[1] + u_val * u_vec[1] + v_val * v_vec[1]
      const pz = center[2] + u_val * u_vec[2] + v_val * v_vec[2]

      const ox = px - origin[0], oy = py - origin[1], oz = pz - origin[2]
      const gx = vt_inv[0][0] * ox + vt_inv[0][1] * oy + vt_inv[0][2] * oz
      const gy = vt_inv[1][0] * ox + vt_inv[1][1] * oy + vt_inv[1][2] * oz
      const gz = vt_inv[2][0] * ox + vt_inv[2][1] * oy + vt_inv[2][2] * oz

      const val = trilinear(data, dims, gx, gy, gz)
      slice_data[row * width + col] = val
      if (val < data_min) data_min = val
      if (val > data_max) data_max = val
    }
  }

  return {
    data: slice_data, width, height,
    min: data_min, max: data_max,
    u_vec, v_vec, normal: unit_normal, center,
    u_min, u_max, v_min, v_max,
  }
}

// ── Canvas rendering ─────────────────────────────────────────────────

/**
 * Crop a slice to a sub-window in plane (u,v) coordinates, returning a new
 * SliceResult with the sub-grid + adjusted extents. Used to "fit to atoms" so a
 * slab cross-section fills the figure instead of being a thin band in vacuum.
 * The colormap range (`min`/`max`) and plane vectors are kept from the full
 * slice so the colorbar and orientation stay consistent.
 */
export function crop_slice(
  slice: SliceResult,
  u_lo: number,
  u_hi: number,
  v_lo: number,
  v_hi: number,
): SliceResult {
  const { data, width, height, u_min, u_max, v_min, v_max } = slice
  const du = u_max - u_min || 1
  const dv = v_max - v_min || 1
  const to_col = (u: number) => Math.round(((u - u_min) / du) * (width - 1))
  const to_row = (v: number) => Math.round(((v - v_min) / dv) * (height - 1))
  let c0 = Math.max(0, Math.min(width - 1, to_col(u_lo)))
  let c1 = Math.max(0, Math.min(width - 1, to_col(u_hi)))
  let r0 = Math.max(0, Math.min(height - 1, to_row(v_lo)))
  let r1 = Math.max(0, Math.min(height - 1, to_row(v_hi)))
  if (c1 < c0) [c0, c1] = [c1, c0]
  if (r1 < r0) [r0, r1] = [r1, r0]
  // Degenerate window → return the full slice untouched.
  if (c1 - c0 < 1 || r1 - r0 < 1) return slice
  const new_w = c1 - c0 + 1
  const new_h = r1 - r0 + 1
  const new_data = new Float64Array(new_w * new_h)
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      new_data[(r - r0) * new_w + (c - c0)] = data[r * width + c]
    }
  }
  return {
    ...slice,
    data: new_data,
    width: new_w,
    height: new_h,
    u_min: u_min + (c0 / (width - 1)) * du,
    u_max: u_min + (c1 / (width - 1)) * du,
    v_min: v_min + (r0 / (height - 1)) * dv,
    v_max: v_min + (r1 / (height - 1)) * dv,
  }
}

/**
 * Render a SliceResult to an HTMLCanvasElement with a selectable colormap.
 * Returns the [min, max] range used for the colorbar.
 */
export function render_slice_to_canvas(
  canvas: HTMLCanvasElement,
  slice: SliceResult,
  colormap: ColormapName = `RdBu`,
  max_canvas_size = 512,
): [number, number] {
  const { data, width, height, min: s_min, max: s_max } = slice
  const stops = COLORMAPS[colormap]

  const scale = Math.min(max_canvas_size / width, max_canvas_size / height, 10)
  const canvas_width = Math.round(width * scale)
  const canvas_height = Math.round(height * scale)
  canvas.width = canvas_width
  canvas.height = canvas_height

  const ctx = canvas.getContext(`2d`)
  if (!ctx) return [s_min, s_max]

  const img_data = ctx.createImageData(canvas_width, canvas_height)
  const pixels = img_data.data
  const val_range = s_max - s_min || 1

  // Diverging colormaps (RdBu, Coolwarm, BrBG, Spectral): high=red→low=blue
  // Sequential colormaps (Viridis, Plasma, Inferno): low→high maps to 0→1
  const is_diverging = colormap === `RdBu` || colormap === `Coolwarm` || colormap === `BrBG` || colormap === `Spectral`

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const val = data[row * width + col]
      let t = (val - s_min) / val_range
      // For diverging: reverse so low values → blue end (t=1)
      if (is_diverging) t = 1 - t
      const [r, g, b] = sample_colormap(stops, t)

      const flipped_row = height - 1 - row
      const py_start = Math.round(flipped_row * scale)
      const py_end = Math.round((flipped_row + 1) * scale)
      const px_start = Math.round(col * scale)
      const px_end = Math.round((col + 1) * scale)
      for (let py = py_start; py < py_end; py++) {
        for (let px = px_start; px < px_end; px++) {
          const off = (py * canvas_width + px) * 4
          pixels[off] = r
          pixels[off + 1] = g
          pixels[off + 2] = b
          pixels[off + 3] = 255
        }
      }
    }
  }

  ctx.putImageData(img_data, 0, 0)
  return [s_min, s_max]
}

// ── Atom projection ──────────────────────────────────────────────────

/**
 * Project atoms onto the slice plane, returning only those within
 * `distance_threshold` of the plane.
 */
export function project_atoms_to_plane(
  atoms: Array<{ position: [number, number, number]; element: string }>,
  normal: Vec3,
  center: Vec3,
  u_vec: Vec3,
  v_vec: Vec3,
  distance_threshold: number,
  radii: Record<string, number>,
): AtomSliceInfo[] {
  const results: AtomSliceInfo[] = []
  for (const atom of atoms) {
    const dx = atom.position[0] - center[0]
    const dy = atom.position[1] - center[1]
    const dz = atom.position[2] - center[2]
    const dist = dx * normal[0] + dy * normal[1] + dz * normal[2]
    if (Math.abs(dist) > distance_threshold) continue
    const u = dx * u_vec[0] + dy * u_vec[1] + dz * u_vec[2]
    const v = dx * v_vec[0] + dy * v_vec[1] + dz * v_vec[2]
    results.push({
      u, v, dist,
      element: atom.element,
      radius: radii[atom.element] ?? 0.5,
    })
  }
  return results
}

/** Parse hex color string to [r, g, b]. */
function hex_to_rgb(hex: string): [number, number, number] {
  const h = hex.replace(`#`, ``)
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ]
}

/**
 * Render a slice with atoms overlaid as 3D-looking spheres.
 * First renders the heatmap, then draws atoms on top with radial gradients.
 */
export function render_atoms_to_canvas(
  canvas: HTMLCanvasElement,
  slice: SliceResult,
  atoms: AtomSliceInfo[],
  element_colors: Record<string, string>,
  colormap: ColormapName = `RdBu`,
  max_canvas_size = 512,
): [number, number] {
  // First render the heatmap
  const range = render_slice_to_canvas(canvas, slice, colormap, max_canvas_size)

  const ctx = canvas.getContext(`2d`)
  if (!ctx || atoms.length === 0) return range

  const { u_min, u_max, v_min, v_max } = slice
  const cw = canvas.width
  const ch = canvas.height

  // Map U/V coords to canvas pixel coords
  const u_to_px = (u: number) => ((u - u_min) / (u_max - u_min)) * cw
  const v_to_py = (v: number) => (1 - (v - v_min) / (v_max - v_min)) * ch

  // Sort by distance so closer atoms (smaller |dist|) render on top
  const sorted = [...atoms].sort((a, b) => Math.abs(b.dist) - Math.abs(a.dist))

  for (const atom of sorted) {
    const px = u_to_px(atom.u)
    const py = v_to_py(atom.v)
    // Scale radius: radius is in Angstroms, convert to pixels
    // u_range in Angstroms maps to canvas_width pixels
    const u_range = u_max - u_min || 1
    const r_px = Math.max(3, (atom.radius / u_range) * cw)

    const [cr, cg, cb] = hex_to_rgb(element_colors[atom.element] ?? `#808080`)

    // Fade atoms that are further from the plane
    const opacity = Math.max(0.3, 1 - Math.abs(atom.dist) * 0.5)

    // Radial gradient: highlight → element color → dark edge
    const grad = ctx.createRadialGradient(
      px - r_px * 0.25, py - r_px * 0.25, r_px * 0.05, // light source offset
      px, py, r_px,
    )
    const lighten = (c: number, f: number) => Math.min(255, Math.round(c + (255 - c) * f))
    const darken = (c: number, f: number) => Math.round(c * (1 - f))
    grad.addColorStop(0, `rgba(${lighten(cr, 0.6)}, ${lighten(cg, 0.6)}, ${lighten(cb, 0.6)}, ${opacity})`)
    grad.addColorStop(0.5, `rgba(${cr}, ${cg}, ${cb}, ${opacity})`)
    grad.addColorStop(1, `rgba(${darken(cr, 0.5)}, ${darken(cg, 0.5)}, ${darken(cb, 0.5)}, ${opacity * 0.8})`)

    ctx.beginPath()
    ctx.arc(px, py, r_px, 0, 2 * Math.PI)
    ctx.fillStyle = grad
    ctx.fill()

    // Subtle outline
    ctx.strokeStyle = `rgba(0, 0, 0, ${opacity * 0.3})`
    ctx.lineWidth = Math.max(0.5, r_px * 0.05)
    ctx.stroke()
  }

  return range
}
