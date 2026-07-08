// Procedural MatCap (material-capture) textures for the atom impostor shader.
//
// A MatCap bakes a fully-lit sphere into a texture that is sampled by the
// view-space surface normal (uv = normal.xy * 0.5 + 0.5). One texture lookup
// replaces all per-fragment lighting — very cheap and gives a rich, stable
// "studio sphere" material feel that doesn't swing as the camera orbits.
//
// These are generated procedurally (zero asset, offline / Tauri-safe) and are
// GRAYSCALE on purpose: the atom shader multiplies the sample by the per-element
// colour, so every atom keeps its element identity while gaining the matcap
// shading. Values are treated as LINEAR (the shader sRGB-encodes at the end), so
// the texture is tagged LinearSRGBColorSpace to avoid a double sRGB decode.

import { CanvasTexture, LinearSRGBColorSpace, type Texture } from 'three'

export const MATCAP_PRESETS = [
  `ceramic`,
  `clay`,
  `glossy`,
  `pearl`,
] as const
export type MatcapPreset = (typeof MATCAP_PRESETS)[number]

interface PresetParams {
  ambient: number // flat fill floor
  diffuse: number // broad Lambert term
  spec: number // specular strength
  specExp: number // specular tightness (higher = smaller/harder highlight)
  rim: number // fresnel darkening at grazing angles
  vGrad: number // top-vs-bottom brightness (fakes a sky-above environment)
}

const PARAMS: Record<MatcapPreset, PresetParams> = {
  // Soft, evenly-lit glazed sphere.
  ceramic: { ambient: 0.34, diffuse: 0.66, spec: 0.35, specExp: 48, rim: 0.14, vGrad: 0 },
  // Flat matte, no specular.
  clay: { ambient: 0.42, diffuse: 0.6, spec: 0, specExp: 1, rim: 0.1, vGrad: 0 },
  // Brighter with a tighter, glossier highlight.
  glossy: { ambient: 0.28, diffuse: 0.6, spec: 0.6, specExp: 90, rim: 0.12, vGrad: 0.12 },
  // Luminous, low-contrast, soft highlight — pearlescent.
  pearl: { ambient: 0.46, diffuse: 0.48, spec: 0.5, specExp: 60, rim: 0.06, vGrad: 0.18 },
}

const cache = new Map<MatcapPreset, Texture>()

export function get_atom_matcap(
  preset: MatcapPreset = `ceramic`,
  onReady?: () => void,
): Texture {
  const key: MatcapPreset = MATCAP_PRESETS.includes(preset) ? preset : `ceramic`
  const hit = cache.get(key)
  if (hit) return hit

  // Metallic uses the bundled chrome photo, not a procedural sphere. Loads async;
  // onReady fires when the image arrives so the scene can repaint (on-demand).
  const size = 256
  // SSR / non-DOM fallback: a 1x1 white texture makes the shader multiply a
  // no-op (atom keeps its flat colour) rather than crashing.
  if (typeof document === `undefined`) {
    const fallback = new CanvasTexture(
      { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) } as unknown as HTMLCanvasElement,
    )
    fallback.colorSpace = LinearSRGBColorSpace
    cache.set(key, fallback)
    return fallback
  }

  const canvas = document.createElement(`canvas`)
  canvas.width = canvas.height = size
  const ctx = canvas.getContext(`2d`)
  if (!ctx) {
    const t = new CanvasTexture(canvas)
    t.colorSpace = LinearSRGBColorSpace
    cache.set(key, t)
    return t
  }

  const p = PARAMS[key]
  const img = ctx.createImageData(size, size)
  const data = img.data

  // Key light toward the upper-left, tilted toward the viewer — the classic
  // 3/4 studio key that reads as "lit from above-left".
  const lx = -0.35, ly = 0.5, lz = 0.78
  const ll = Math.hypot(lx, ly, lz)
  const Lx = lx / ll, Ly = ly / ll, Lz = lz / ll
  const hx = Lx, hy = Ly, hz = Lz + 1
  const hl = Math.hypot(hx, hy, hz)
  const Hx = hx / hl, Hy = hy / hl, Hz = hz / hl

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const nx = (x / (size - 1)) * 2 - 1
      const ny = -((y / (size - 1)) * 2 - 1) // flip: canvas y grows downward
      const r2 = nx * nx + ny * ny
      if (r2 > 1) {
        data[i] = data[i + 1] = data[i + 2] = 12
        data[i + 3] = 255
        continue
      }
      const nz = Math.sqrt(1 - r2)
      const diffuse = Math.max(nx * Lx + ny * Ly + nz * Lz, 0)
      const specular = Math.pow(Math.max(nx * Hx + ny * Hy + nz * Hz, 0), p.specExp)

      const rim = Math.pow(1 - nz, 3)
      const topGrad = ny * 0.5 + 0.5 // 0 bottom .. 1 top (fake sky reflection)
      let v = p.ambient + p.diffuse * diffuse + p.spec * specular
        - p.rim * rim + p.vGrad * topGrad
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
  cache.set(key, tex)
  return tex
}
