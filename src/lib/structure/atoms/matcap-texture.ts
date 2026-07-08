// Procedural MatCap (material-capture) texture for the atom impostor shader.
//
// A MatCap bakes a fully-lit sphere into a texture that is sampled by the
// view-space surface normal (uv = normal.xy * 0.5 + 0.5). One texture lookup
// replaces all per-fragment lighting — very cheap and gives a rich, stable
// "studio sphere" material feel that doesn't swing as the camera orbits.
//
// This one is generated procedurally (zero asset, offline / Tauri-safe) and is
// GRAYSCALE on purpose: the atom shader multiplies it by the per-element colour,
// so every atom keeps its element identity while gaining the matcap shading.
// Values are treated as LINEAR (the shader sRGB-encodes at the end), so the
// texture is tagged LinearSRGBColorSpace to avoid a double sRGB decode.

import { CanvasTexture, LinearSRGBColorSpace, type Texture } from 'three'

let cached: Texture | null = null

export function get_atom_matcap(): Texture {
  if (cached) return cached

  const size = 256
  // SSR / non-DOM fallback: a 1x1 white texture makes the shader multiply a
  // no-op (atom keeps its flat colour) rather than crashing.
  if (typeof document === `undefined`) {
    const fallback = new CanvasTexture(
      { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) } as unknown as HTMLCanvasElement,
    )
    fallback.colorSpace = LinearSRGBColorSpace
    cached = fallback
    return fallback
  }

  const canvas = document.createElement(`canvas`)
  canvas.width = canvas.height = size
  const ctx = canvas.getContext(`2d`)
  if (!ctx) {
    const t = new CanvasTexture(canvas)
    t.colorSpace = LinearSRGBColorSpace
    cached = t
    return t
  }

  const img = ctx.createImageData(size, size)
  const data = img.data

  // Key light toward the upper-left, tilted toward the viewer — the classic
  // 3/4 studio key that reads as "lit from above-left".
  const lx = -0.35, ly = 0.5, lz = 0.78
  const ll = Math.hypot(lx, ly, lz)
  const Lx = lx / ll, Ly = ly / ll, Lz = lz / ll
  // Half-vector between the key light and the view direction (0,0,1).
  const hx = Lx, hy = Ly, hz = Lz + 1
  const hl = Math.hypot(hx, hy, hz)
  const Hx = hx / hl, Hy = hy / hl, Hz = hz / hl

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // Reconstruct the unit-sphere normal for this texel.
      const nx = (x / (size - 1)) * 2 - 1
      const ny = -((y / (size - 1)) * 2 - 1) // flip: canvas y grows downward
      const r2 = nx * nx + ny * ny
      if (r2 > 1) {
        // Outside the sphere disk — never sampled (uv stays inside the disk),
        // fill with the rim tone for safety.
        data[i] = data[i + 1] = data[i + 2] = 20
        data[i + 3] = 255
        continue
      }
      const nz = Math.sqrt(1 - r2)
      const diffuse = Math.max(nx * Lx + ny * Ly + nz * Lz, 0)
      const specular = Math.pow(Math.max(nx * Hx + ny * Hy + nz * Hz, 0), 48)
      const rim = Math.pow(1 - nz, 3) // subtle fresnel darkening at grazing angles

      // Soft ceramic response: ambient floor + broad diffuse + a gentle
      // specular pop, minus a touch of rim so spheres read as rounded volumes.
      let v = 0.34 + 0.66 * diffuse + 0.35 * specular - 0.14 * rim
      v = Math.max(0, Math.min(1, v))
      const c = Math.round(v * 255)
      data[i] = data[i + 1] = data[i + 2] = c
      data[i + 3] = 255
    }
  }

  ctx.putImageData(img, 0, 0)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = LinearSRGBColorSpace
  tex.needsUpdate = true
  cached = tex
  return tex
}
