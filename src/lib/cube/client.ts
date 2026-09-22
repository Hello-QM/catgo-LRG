/** Persistent scalar Rust Cube processing, with an explicit TypeScript Worker fallback. */
import { compile_wasm_module } from '$lib/structure/ferrox-wasm'
import type { CubeMesh } from './api'
import type { ParsedCubeData, VolumetricGrid } from './parse-cube'
import type { CubeWorkerCommand, CubeWorkerReply } from './worker-protocol'
import RustCubeWorker from './rust-cube.worker-scalar.ts?worker&inline'
import MarchingCubesWorker from './marching-cubes.worker.ts?worker&inline'

class CubeInputError extends Error {}
const cancelled = () => new DOMException(`Cube operation cancelled`, `AbortError`)

class CubeWorkerRpc {
  private next_id = 0
  private closed = false
  private pending = new Map<number, {
    resolve: (reply: CubeWorkerReply) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private worker: Worker) {
    worker.onmessage = (event: MessageEvent<CubeWorkerReply>) => {
      const reply = event.data
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      clearTimeout(pending.timer)
      if (reply.type === `error`) {
        pending.reject(reply.kind === `input` ? new CubeInputError(reply.message) : new Error(reply.message))
      } else pending.resolve(reply)
    }
    worker.onerror = event => this.close(new Error(event.message || `Cube worker crashed`))
    worker.onmessageerror = () => this.close(new Error(`Cube worker message could not be decoded`))
  }

  request(command: CubeWorkerCommand, transfer: Transferable[] = []): Promise<CubeWorkerReply> {
    if (this.closed) return Promise.reject(new Error(`Cube worker is closed`))
    const id = ++this.next_id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Cube worker timed out`)), command.type === `init` ? 30_000 : 120_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ ...command, id }, transfer) }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  close(error: Error = cancelled()): void {
    this.closed = true
    this.worker.terminate()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function copy_grid(grid: VolumetricGrid): VolumetricGrid {
  // Strip Svelte proxies and keep the caller's buffer attached for slice views.
  return {
    data: new Float32Array(grid.data), dims: [...grid.dims], origin: [...grid.origin],
    voxel_axes: [[...grid.voxel_axes[0]], [...grid.voxel_axes[1]], [...grid.voxel_axes[2]]],
    data_min: grid.data_min, data_max: grid.data_max,
  }
}

export type CubeBackend = `rust` | `typescript`
export interface CubeExtractionResult {
  positive: CubeMesh | null
  negative: CubeMesh | null
  elapsed_ms: number
  backend: CubeBackend
}

/** One viewer owns one volume and worker; closing it cannot cancel another viewer. */
export class CubeClient {
  private rust: CubeWorkerRpc | null = null
  private fallback: CubeWorkerRpc | null = null
  private rust_disabled = false
  private warned = new Set<string>()
  private parsed_grid: VolumetricGrid | null = null
  private loaded_grid: VolumetricGrid | null = null
  private generation = 0
  private queue: Promise<unknown> = Promise.resolve()
  private cancellations = new Set<() => void>()

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const result = new Promise<T>((resolve, reject) => {
      const cancel = () => reject(cancelled())
      this.cancellations.add(cancel)
      this.queue.then(async () => {
        if (generation !== this.generation) throw cancelled()
        const value = await work()
        if (generation !== this.generation) throw cancelled()
        return value
      }).then(resolve, reject).finally(() => this.cancellations.delete(cancel))
    })
    this.queue = result.catch(() => undefined)
    return result
  }

  private async rust_worker(): Promise<CubeWorkerRpc> {
    if (this.rust) return this.rust
    const generation = this.generation
    const module = await compile_wasm_module(`scalar`)
    if (generation !== this.generation) throw cancelled()
    this.rust = new CubeWorkerRpc(new RustCubeWorker())
    const reply = await this.rust.request({ type: `init`, module })
    if (reply.type !== `ready`) throw new Error(`Invalid Rust Cube initialization reply`)
    return this.rust
  }

  private async with_backend(
    stage: `parser` | `extractor`,
    rust: (worker: CubeWorkerRpc) => Promise<CubeWorkerReply>,
    fallback: (worker: CubeWorkerRpc) => Promise<CubeWorkerReply>,
  ): Promise<{ reply: CubeWorkerReply; backend: CubeBackend }> {
    const generation = this.generation
    if (!this.rust_disabled) {
      try { return { reply: await rust(await this.rust_worker()), backend: `rust` } }
      catch (error) {
        if (generation !== this.generation || (error instanceof Error && error.name === `AbortError`)) throw cancelled()
        // Invalid scientific input must stay an error, not silently select a different parser.
        if (error instanceof CubeInputError) throw error
        this.rust?.close()
        this.rust = null
        this.loaded_grid = null
        this.rust_disabled = true
      }
    }
    if (!this.warned.has(stage)) {
      console.warn(stage === `parser`
        ? `Rust/WASM parser unavailable; using TypeScript worker`
        : `Rust/WASM extractor unavailable; using TypeScript worker`)
      this.warned.add(stage)
    }
    this.fallback ??= new CubeWorkerRpc(new MarchingCubesWorker())
    try { return { reply: await fallback(this.fallback), backend: `typescript` } }
    catch (error) {
      if (generation !== this.generation) throw cancelled()
      if (!(error instanceof CubeInputError)) {
        this.fallback?.close()
        this.fallback = null
      }
      throw error
    }
  }

  /** The returned grid is a read-only snapshot for slices; isovalue changes reuse the Rust volume. */
  parse(text: string): Promise<ParsedCubeData & { backend: CubeBackend }> {
    return this.enqueue(async () => {
      this.parsed_grid = this.loaded_grid = null
      const { reply, backend } = await this.with_backend(`parser`,
        worker => worker.request({ type: `parse`, text }),
        worker => worker.request({ type: `parse`, text }))
      if (reply.type !== `parsed`) throw new Error(`Invalid Cube parser reply`)
      if (backend === `rust`) this.parsed_grid = this.loaded_grid = reply.result.grid
      return { ...reply.result, backend }
    })
  }

  extract(grid: VolumetricGrid, isovalue: number, dual: boolean): Promise<CubeExtractionResult> {
    return this.enqueue(async () => {
      const { reply, backend } = await this.with_backend(`extractor`, async worker => {
        // External grids are reloaded, retaining the legacy API's mutable-grid behavior.
        if (grid !== this.parsed_grid || grid !== this.loaded_grid) {
          this.loaded_grid = null
          const copy = copy_grid(grid)
          const loaded = await worker.request({ type: `load`, grid: copy }, [copy.data.buffer as ArrayBuffer])
          if (loaded.type !== `loaded`) throw new Error(`Invalid Cube load reply`)
          this.loaded_grid = grid
        }
        return worker.request({ type: `extract`, isovalue, dual })
      }, worker => {
        const copy = copy_grid(grid)
        return worker.request({ type: `extract`, isovalue, dual, grid: copy }, [copy.data.buffer as ArrayBuffer])
      })
      if (reply.type !== `mesh`) throw new Error(`Invalid Cube mesh reply`)
      return {
        positive: reply.positive.positions.length ? reply.positive : null,
        negative: reply.negative?.positions.length ? reply.negative : null,
        elapsed_ms: reply.elapsed_ms, backend,
      }
    })
  }

  /** Stop computation and reject outstanding/queued requests instead of leaving promises pending. */
  dispose(): void {
    this.generation++
    for (const cancel of this.cancellations) cancel()
    this.cancellations.clear()
    this.rust?.close()
    this.fallback?.close()
    this.rust = this.fallback = null
    this.parsed_grid = this.loaded_grid = null
    this.rust_disabled = false
    this.warned.clear()
    this.queue = Promise.resolve()
  }
}

// Preserve the existing module API for callers that do not own a viewer instance.
const default_client = new CubeClient()
export const parse_cube_client = (text: string) => default_client.parse(text)
export const extract_isosurface_client = (grid: VolumetricGrid, isovalue: number, dual: boolean) => default_client.extract(grid, isovalue, dual)
export const cancel_extraction = () => default_client.dispose()
export const dispose_worker = () => default_client.dispose()
