import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CubeWorkerRequest } from '$lib/cube/worker-protocol'

const mocks = vi.hoisted(() => {
  class WorkerMock {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    onmessageerror: (() => void) | null = null
    terminated = false
    requests: any[] = []
    constructor(readonly backend: string) { instances.push(this) }
    postMessage(request: unknown, transfer: Transferable[]) {
      const copy = structuredClone(request, { transfer })
      this.requests.push(copy)
      queueMicrotask(() => { if (!this.terminated) handler(this, copy) })
    }
    reply(request: any, response: object) { this.onmessage?.({ data: { id: request.id, ...response } }) }
    terminate() { this.terminated = true }
  }
  const instances: WorkerMock[] = []
  let handler: (worker: WorkerMock, request: any) => void = () => {}
  return { instances, WorkerMock, compile: vi.fn(), setHandler: (next: typeof handler) => { handler = next } }
})
vi.mock('$lib/structure/ferrox-wasm', () => ({ compile_wasm_module: mocks.compile }))
vi.mock('$lib/cube/rust-cube.worker-scalar.ts?worker&inline', () => ({
  default: class extends mocks.WorkerMock { constructor() { super('rust') } },
}))
vi.mock('$lib/cube/marching-cubes.worker.ts?worker&inline', () => ({
  default: class extends mocks.WorkerMock { constructor() { super('typescript') } },
}))
import { CubeClient } from '$lib/cube/client'
import { parse_cube_full } from '$lib/cube/parse-cube'

const cube = `density\nfixture\n1 0 0 0\n2 1 0 0\n1 0 1 0\n1 0 0 1\n1 0 1 0 0\n0.125 0.25\n`
const clients: CubeClient[] = []
const client = () => { const value = new CubeClient(); clients.push(value); return value }
const empty_mesh = () => ({ positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() })
function respond(worker: InstanceType<typeof mocks.WorkerMock>, request: CubeWorkerRequest) {
  if (request.type === 'init') worker.reply(request, { type: 'ready' })
  if (request.type === 'parse') worker.reply(request, { type: 'parsed', result: parse_cube_full(request.text) })
  if (request.type === 'load') worker.reply(request, { type: 'loaded' })
  if (request.type === 'extract') worker.reply(request, { type: 'mesh', positive: empty_mesh(), negative: request.dual ? empty_mesh() : null, elapsed_ms: 1 })
}
beforeEach(() => {
  mocks.instances.length = 0
  mocks.compile.mockReset().mockResolvedValue({})
  mocks.setHandler(respond)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { clients.splice(0).forEach(value => value.dispose()); vi.restoreAllMocks() })

it('serializes requests and reuses the parsed Rust volume across isovalues', async () => {
  const value = client()
  const parsed = await value.parse(cube)
  const results = await Promise.all([value.extract(parsed.grid, 0.15, false), value.extract(parsed.grid, 0.2, true)])
  expect(parsed.backend).toBe('rust')
  expect(results.map(result => result.backend)).toEqual(['rust', 'rust'])
  expect(mocks.instances).toHaveLength(1)
  expect(mocks.instances[0].requests.map(request => request.type)).toEqual(['init', 'parse', 'extract', 'extract'])
  expect(mocks.instances[0].requests.map(request => request.id)).toEqual([1, 2, 3, 4])
  expect(Array.from(parsed.grid.data)).toEqual([0.125, 0.25])
})

it('copies external grids before transfer and reloads mutable grid input', async () => {
  const value = client()
  const { grid } = parse_cube_full(cube)
  await value.extract(grid, 0.15, false)
  grid.data[0] = 0.5
  await value.extract(grid, 0.2, false)
  const loads = mocks.instances[0].requests.filter(request => request.type === 'load')
  expect(loads).toHaveLength(2)
  expect(loads[0].grid.data[0]).toBe(0.125)
  expect(loads[1].grid.data[0]).toBe(0.5)
  expect(grid.data.byteLength).toBe(8)
})

it('falls back to a TypeScript worker when WASM initialization fails', async () => {
  mocks.compile.mockRejectedValue(new Error('unavailable'))
  const value = client()
  const parsed = await value.parse(cube)
  expect(parsed.backend).toBe('typescript')
  expect((await value.extract(parsed.grid, 0.2, true)).backend).toBe('typescript')
  expect(Array.from(parsed.grid.data)).toEqual([0.125, 0.25])
  expect(console.warn).toHaveBeenCalledWith('Rust/WASM parser unavailable; using TypeScript worker')
  expect(console.warn).toHaveBeenCalledWith('Rust/WASM extractor unavailable; using TypeScript worker')
})

it('does not hide invalid scientific input behind a parser fallback', async () => {
  mocks.setHandler((worker, request) => request.type === 'parse'
    ? worker.reply(request, { type: 'error', kind: 'input', message: 'Multiple Cube datasets are not supported' })
    : respond(worker, request))
  await expect(client().parse(cube)).rejects.toThrow('Multiple Cube datasets')
  expect(mocks.instances.map(worker => worker.backend)).toEqual(['rust'])
  expect(console.warn).not.toHaveBeenCalled()
})

it('recovers from a crashed Rust worker by extracting on the fallback', async () => {
  const value = client()
  const parsed = await value.parse(cube)
  mocks.setHandler((worker, request) => worker.backend === 'rust'
    ? worker.onerror?.({ message: 'worker crashed' }) : respond(worker, request))
  expect((await value.extract(parsed.grid, 0.2, true)).backend).toBe('typescript')
  expect(mocks.instances[0].terminated).toBe(true)
  expect(parsed.grid.data.byteLength).toBe(8)
})

it('rejects in-flight and queued requests on disposal without cancelling another viewer', async () => {
  const first = client()
  const second = client()
  const parsed = await second.parse(cube)
  mocks.setHandler((worker, request) => { if (request.type !== 'parse') respond(worker, request) })
  const pending = first.parse(cube)
  const queued = first.parse(cube)
  const rejected = Promise.all([expect(pending).rejects.toMatchObject({ name: 'AbortError' }), expect(queued).rejects.toMatchObject({ name: 'AbortError' })])
  await vi.waitFor(() => expect(mocks.instances.some(worker => worker.requests.some(request => request.type === 'parse') && worker !== mocks.instances[0])).toBe(true))
  first.dispose()
  await rejected
  expect((await second.extract(parsed.grid, 0.2, false)).backend).toBe('rust')
})

it('cancels immediately while compilation is pending and does not create a late worker', async () => {
  let finish!: (value: unknown) => void
  mocks.compile.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const value = client()
  const pending = value.parse(cube)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(mocks.compile).toHaveBeenCalled())
  value.dispose()
  await rejected
  finish({})
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(mocks.instances).toHaveLength(0)
})

it('can reuse a client after cancelling an in-flight fallback request', async () => {
  mocks.compile.mockRejectedValue(new Error('unavailable'))
  const value = client()
  mocks.setHandler(() => {})
  const first = value.parse(cube)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(mocks.instances[0]?.requests).toHaveLength(1))
  value.dispose()
  mocks.setHandler(respond)
  const next = value.parse(cube)
  await rejected
  expect((await next).backend).toBe('typescript')
  expect(mocks.instances[1].terminated).toBe(false)
})
