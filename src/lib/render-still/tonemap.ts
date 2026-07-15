/**
 * CPU-side tone mapping for path-traced float render targets.
 *
 * The PNG readback path goes through `readRenderTargetPixels` on the
 * path tracer's FLOAT accumulation target (avoids the browser
 * drawingBuffer clamp for large exports), so the ACES-filmic +
 * linear→sRGB transform the WebGLRenderer would normally apply on blit
 * has to be replicated here. The math is a port of three.js'
 * `ACESFilmicToneMapping` GLSL (Stephen Hill's fitted ACES curve).
 */

/** three.js sRGB OETF (linear → sRGB, per channel, input clamped implicitly) */
export function linear_to_srgb(c: number): number {
  if (c <= 0) return 0
  if (c >= 1) return 1
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * ACES filmic tone map, identical to three.js' shader implementation:
 * exposure pre-scale (÷0.6 folded in), ACES input matrix, RRT+ODT fit,
 * ACES output matrix, clamp.
 */
export function aces_filmic_tonemap(
  r: number,
  g: number,
  b: number,
  exposure = 1,
): [number, number, number] {
  const s = exposure / 0.6
  let x = r * s
  let y = g * s
  let z = b * s

  // ACESInputMat (rows of the linear transform)
  let ix = 0.59719 * x + 0.35458 * y + 0.04823 * z
  let iy = 0.07600 * x + 0.90834 * y + 0.01566 * z
  let iz = 0.02840 * x + 0.13383 * y + 0.83777 * z

  // RRTAndODTFit
  const fit = (v: number): number =>
    (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
  ix = fit(ix)
  iy = fit(iy)
  iz = fit(iz)

  // ACESOutputMat
  x = 1.60475 * ix - 0.53108 * iy - 0.07367 * iz
  y = -0.10208 * ix + 1.10813 * iy - 0.00605 * iz
  z = -0.00327 * ix - 0.07276 * iy + 1.07602 * iz

  return [Math.min(Math.max(x, 0), 1), Math.min(Math.max(y, 0), 1), Math.min(Math.max(z, 0), 1)]
}

/**
 * Convert a bottom-left-origin float RGBA readback buffer into
 * top-left-origin 8-bit sRGB pixels ready for `ImageData`.
 *
 * - Un-premultiplies by alpha when alpha accumulation is active (a > 0).
 * - Applies ACES filmic + linear→sRGB.
 * - Flips vertically (GL readback origin is bottom-left; canvases are
 *   top-left).
 */
export function float_rgba_to_srgb_pixels(
  data: Float32Array,
  width: number,
  height: number,
  exposure = 1,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    const src_row = height - 1 - row
    for (let col = 0; col < width; col++) {
      const si = (src_row * width + col) * 4
      const di = (row * width + col) * 4
      let r = data[si]
      let g = data[si + 1]
      let b = data[si + 2]
      const a = data[si + 3]
      if (a > 0 && a !== 1) {
        r /= a
        g /= a
        b /= a
      }
      const [tr, tg, tb] = aces_filmic_tonemap(r, g, b, exposure)
      out[di] = Math.round(linear_to_srgb(tr) * 255)
      out[di + 1] = Math.round(linear_to_srgb(tg) * 255)
      out[di + 2] = Math.round(linear_to_srgb(tb) * 255)
      out[di + 3] = 255
    }
  }
  return out
}
