// The portable scalar artifact is also used by non-isolated DSH Blob workers.
import * as glue from '@catgo/ferrox-wasm'
import type { CubeHeader } from './api'
import type { MeshData } from './marching-cubes'
import { mesh_buffers, type CubeWorkerRequest } from './worker-protocol'

let volume: InstanceType<typeof glue.WasmCubeVolume> | null = null
let ready = false

function release_volume(): void {
  volume?.free()
  volume = null
}

function extract(isovalue: number): MeshData {
  if (!volume) throw new Error(`No Cube volume loaded`)
  const mesh = volume.extract(isovalue)
  try {
    return { positions: mesh.positions(), normals: mesh.normals(), indices: mesh.indices() }
  } finally {
    mesh.free()
  }
}

self.onmessage = async (event: MessageEvent<CubeWorkerRequest>) => {
  const request = event.data
  const { id } = request
  try {
    if (request.type === `init`) {
      await glue.default({ module_or_path: request.module })
      if (typeof glue.WasmCubeVolume !== `function`) throw new Error(`WasmCubeVolume is unavailable`)
      ready = true
      self.postMessage({ id, type: `ready` })
      return
    }
    if (!ready) throw new Error(`Rust Cube worker is not initialized`)
    if (request.type === `parse`) {
      release_volume()
      volume = new glue.WasmCubeVolume(request.text)
      const header = volume.header() as CubeHeader
      const data = volume.data()
      self.postMessage({
        id, type: `parsed`, result: {
          header,
          grid: {
            data, dims: header.dims, origin: header.origin, voxel_axes: header.voxel_axes,
            data_min: volume.data_min(), data_max: volume.data_max(),
          },
        },
      }, { transfer: [data.buffer as ArrayBuffer] })
    } else if (request.type === `load`) {
      const { grid } = request
      if (!grid.dims.every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) {
        throw new Error(`Invalid Cube grid dimensions`)
      }
      release_volume()
      volume = glue.WasmCubeVolume.from_grid(
        Uint32Array.from(grid.dims), Float64Array.from(grid.origin),
        Float64Array.from(grid.voxel_axes.flat()), grid.data,
      )
      self.postMessage({ id, type: `loaded` })
    } else {
      const start = performance.now()
      const positive = extract(request.isovalue)
      const negative = request.dual ? extract(-request.isovalue) : null
      self.postMessage({ id, type: `mesh`, positive, negative, elapsed_ms: performance.now() - start }, {
        transfer: [...mesh_buffers(positive), ...(negative ? mesh_buffers(negative) : [])],
      })
    }
  } catch (error) {
    self.postMessage({
      id, type: `error`,
      kind: request.type === `init` || !ready || error instanceof WebAssembly.RuntimeError ? `backend` : `input`,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
