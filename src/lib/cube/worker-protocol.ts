import type { MeshData } from './marching-cubes'
import type { ParsedCubeData, VolumetricGrid } from './parse-cube'

export type CubeWorkerCommand =
  | { type: `init`; module: WebAssembly.Module }
  | { type: `parse`; text: string }
  | { type: `load`; grid: VolumetricGrid }
  | { type: `extract`; isovalue: number; dual: boolean; grid?: VolumetricGrid }

export type CubeWorkerRequest = CubeWorkerCommand & { id: number }

export type CubeWorkerReply = { id: number } & (
  | { type: `ready` | `loaded` }
  | { type: `parsed`; result: ParsedCubeData }
  | { type: `mesh`; positive: MeshData; negative: MeshData | null; elapsed_ms: number }
  | { type: `error`; kind: `input` | `backend`; message: string }
)

export function mesh_buffers(mesh: MeshData): ArrayBuffer[] {
  return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer] as ArrayBuffer[]
}
