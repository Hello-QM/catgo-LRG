/**
 * Web Worker for off-main-thread isosurface extraction.
 * Receives volumetric grid data + isovalue, returns mesh data.
 * Uses transferable buffers for zero-copy message passing.
 */

import { extract_isosurface } from './marching-cubes'
import type { VolumetricGrid } from './parse-cube'

export interface WorkerInput {
  type: `extract`
  grid: VolumetricGrid
  isovalue: number
  dual: boolean
}

export interface WorkerMeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

export interface WorkerOutput {
  type: `result`
  positive: WorkerMeshData
  negative: WorkerMeshData | null
  elapsed_ms: number
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { grid, isovalue, dual } = event.data
  const start = performance.now()

  const positive = extract_isosurface(grid, isovalue)
  const negative = dual ? extract_isosurface(grid, -isovalue) : null

  const elapsed_ms = performance.now() - start

  const transferable: Transferable[] = [
    positive.positions.buffer as ArrayBuffer,
    positive.normals.buffer as ArrayBuffer,
    positive.indices.buffer as ArrayBuffer,
  ]
  if (negative) {
    transferable.push(
      negative.positions.buffer as ArrayBuffer,
      negative.normals.buffer as ArrayBuffer,
      negative.indices.buffer as ArrayBuffer,
    )
  }

  const result: WorkerOutput = { type: `result`, positive, negative, elapsed_ms }
  ;(self as unknown as Worker).postMessage(result, transferable)
}
