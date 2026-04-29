// Project a world-space xyz to a pixel coordinate inside the canvas.
//
// Reads matrices via the StructureScene probe surface
// (`globalThis.__catgo_probe.get_camera_matrices()`), which returns
// `projection.elements` and `matrixWorldInverse.elements` (the view matrix)
// from Three.js — both column-major Float32Array of length 16. The helper
// therefore applies them column-by-column.
//
// Used by W7 Tests 2.1, 2.5 (and future 2.2, 7.4) to compute "click here"
// pixel coordinates from atom xyz read out of the probe surface. See
// plans/W7-milestone-5-todo.md § "Why some tests are deliberately deferred"
// for the empirical case.
//
// Returns null if the point is behind the camera (clip-space w <= 0) or if
// matrices are missing — callers should treat null as "skip this test
// gracefully" rather than fail at the projection step.

export interface CameraMatrices {
  projection: number[]
  view: number[]
  width: number
  height: number
}

export interface PixelCoord {
  x: number
  y: number
}

// Apply a 4x4 column-major matrix to a 4-vector.
// `m[col*4 + row]` is the convention used by Three.js Matrix4.elements.
function apply_matrix4(
  m: number[],
  v: [number, number, number, number],
): [number, number, number, number] {
  const [x, y, z, w] = v
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ]
}

export function project_to_pixel(
  matrices: CameraMatrices | null,
  xyz: [number, number, number],
): PixelCoord | null {
  if (!matrices) return null
  const { projection, view, width, height } = matrices
  if (projection.length !== 16 || view.length !== 16) return null

  // 1. World → view space.
  const view_space = apply_matrix4(view, [xyz[0], xyz[1], xyz[2], 1])
  // 2. View → clip space.
  const clip = apply_matrix4(projection, view_space)
  const wc = clip[3]
  // 3. Behind camera (perspective: w<=0 means at/behind eye plane).
  if (wc <= 0) return null
  // 4. Clip → NDC (in [-1, 1]).
  const ndc_x = clip[0] / wc
  const ndc_y = clip[1] / wc
  // 5. NDC → pixel (canvas-relative). Y is flipped: NDC y points up,
  // canvas y points down. Origin is the canvas's top-left corner.
  const px = (ndc_x * 0.5 + 0.5) * width
  const py = (1 - (ndc_y * 0.5 + 0.5)) * height
  return { x: px, y: py }
}
