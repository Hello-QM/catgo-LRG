/**
 * Client-side isosurface extraction orchestration.
 * Manages a singleton Web Worker for off-main-thread marching cubes.
 * Provides an async API matching the server-side CubeMesh types.
 */

import type { CubeMesh } from './api'
import type { VolumetricGrid } from './parse-cube'
import type { WorkerOutput } from './marching-cubes.worker'
// Inline-bundle the worker as a blob URL so it works under VSCode webview's
// `vscode-webview://` origin, where same-host `/assets/*.js` fetches are
// rejected as cross-origin against `vscode-resource://` asset URLs.
import MarchingCubesWorker from './marching-cubes.worker.ts?worker&inline'

let worker: Worker | null = null
let generation = 0

function get_worker(): Worker {
  if (!worker) {
    worker = new MarchingCubesWorker()
  }
  return worker
}

/**
 * Extract isosurface(s) from volumetric grid data using a Web Worker.
 * Returns CubeMesh-compatible results (Float32Array/Uint32Array).
 */
export async function extract_isosurface_client(
  grid: VolumetricGrid,
  isovalue: number,
  dual: boolean,
): Promise<{ positive: CubeMesh | null; negative: CubeMesh | null; elapsed_ms: number }> {
  const current_gen = ++generation
  const w = get_worker()

  // Deep-copy all grid fields to strip Svelte $state proxies (not structured-cloneable)
  const grid_copy: VolumetricGrid = {
    data: new Float32Array(grid.data),
    dims: [grid.dims[0], grid.dims[1], grid.dims[2]],
    origin: [grid.origin[0], grid.origin[1], grid.origin[2]],
    voxel_axes: [
      [grid.voxel_axes[0][0], grid.voxel_axes[0][1], grid.voxel_axes[0][2]],
      [grid.voxel_axes[1][0], grid.voxel_axes[1][1], grid.voxel_axes[1][2]],
      [grid.voxel_axes[2][0], grid.voxel_axes[2][1], grid.voxel_axes[2][2]],
    ],
    data_min: grid.data_min,
    data_max: grid.data_max,
  }

  return new Promise((resolve, reject) => {
    const onmessage = (event: MessageEvent<WorkerOutput>) => {
      w.removeEventListener(`message`, onmessage)
      w.removeEventListener(`error`, onerror)

      // Ignore stale results (from a cancelled extraction)
      if (current_gen !== generation) return

      const { positive, negative, elapsed_ms } = event.data
      resolve({
        positive:
          positive.positions.length > 0
            ? {
                positions: positive.positions,
                normals: positive.normals,
                indices: positive.indices,
              }
            : null,
        negative:
          negative && negative.positions.length > 0
            ? {
                positions: negative.positions,
                normals: negative.normals,
                indices: negative.indices,
              }
            : null,
        elapsed_ms,
      })
    }

    const onerror = (event: ErrorEvent) => {
      w.removeEventListener(`message`, onmessage)
      w.removeEventListener(`error`, onerror)
      reject(new Error(event.message || `Worker error`))
    }

    w.addEventListener(`message`, onmessage)
    w.addEventListener(`error`, onerror)

    // Transfer the copied buffer to the worker
    w.postMessage(
      { type: `extract`, grid: grid_copy, isovalue, dual },
      [grid_copy.data.buffer as ArrayBuffer],
    )
  })
}

/** Cancel any in-flight extraction (stale results will be ignored). */
export function cancel_extraction(): void {
  generation++
}

/** Terminate the worker and free resources. */
export function dispose_worker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  generation++
}
