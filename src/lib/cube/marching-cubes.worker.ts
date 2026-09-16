/** TypeScript fallback for Cube parsing and isosurface extraction. */
import { extract_isosurface } from './marching-cubes'
import { parse_cube_full } from './parse-cube'
import { mesh_buffers, type CubeWorkerRequest } from './worker-protocol'

self.onmessage = (event: MessageEvent<CubeWorkerRequest>) => {
  const { id } = event.data
  try {
    const request = event.data
    if (request.type === `parse`) {
      const result = parse_cube_full(request.text)
      self.postMessage({ id, type: `parsed`, result }, { transfer: [result.grid.data.buffer as ArrayBuffer] })
    } else if (request.type === `extract` && request.grid) {
      if (!Number.isFinite(request.isovalue)) throw new Error(`Cube isovalue must be finite`)
      const start = performance.now()
      const positive = extract_isosurface(request.grid, request.isovalue)
      const negative = request.dual ? extract_isosurface(request.grid, -request.isovalue) : null
      self.postMessage({ id, type: `mesh`, positive, negative, elapsed_ms: performance.now() - start }, {
        transfer: [...mesh_buffers(positive), ...(negative ? mesh_buffers(negative) : [])],
      })
    } else {
      throw new Error(`Invalid TypeScript Cube worker request`)
    }
  } catch (error) {
    self.postMessage({ id, type: `error`, kind: `input`, message: error instanceof Error ? error.message : String(error) })
  }
}
