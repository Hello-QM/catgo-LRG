import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BondBackendCapabilities } from '$lib/structure/workers/bond-backend-policy'
import {
  BondBackendUnavailableError,
  type BondWorkerHandle,
  type BondWorkerRuntime,
  create_bond_worker_runtime,
  LARGE_SYSTEM_MIN_ATOMS,
  type TypedBondInput,
  type TypedBondTable,
} from '$lib/structure/workers/bond-worker-runtime'
import {
  compute_bonds_async,
  RealBondWorkerHandle,
  set_bond_worker_runtime_for_tests,
} from '$lib/structure/workers/bond-worker-api'
import { BONDING_STRATEGIES } from '$lib/structure/bonding'
import type { AnyStructure } from '$lib'

// ─── fixtures ───

const full_caps = (hardware_concurrency: number): BondBackendCapabilities => ({
  cross_origin_isolated: true,
  shared_array_buffer: true,
  wasm_atomics: true,
  hardware_concurrency,
})

const fixed_table: TypedBondTable = {
  pairs: new Uint32Array([0, 1]),
  images: new Int8Array([0, 0, 0]),
  lengths: new Float32Array([1.5]),
  strengths: new Float32Array([1]),
}

const fake_handle = (): BondWorkerHandle => ({
  compute_typed: vi.fn(() => Promise.resolve(fixed_table)),
  terminate: vi.fn(),
})

const typed_input = (atom_count: number): TypedBondInput => ({
  positions: new Float32Array(atom_count * 3),
  atomic_numbers: new Uint8Array(atom_count),
  lattice_matrix: null,
  pbc: null,
  options: {},
})

const fail_factory = (msg: string) =>
  vi.fn((_thread_count: number) => Promise.reject<BondWorkerHandle>(new Error(msg)))

const big_structure = (n_sites: number): AnyStructure =>
  ({ sites: Array.from({ length: n_sites }, () => ({})) }) as unknown as AnyStructure

afterEach(() => {
  set_bond_worker_runtime_for_tests(null)
})

// ─── mandated tests (design §6.3 / §8.3) ───

describe(`bond worker runtime selection`, () => {
  it(`falls back from threaded init to scalar exactly once`, async () => {
    const threaded = fail_factory(`COI worker refused to start`)
    const handle = fake_handle()
    const scalar = vi.fn((_thread_count: number) => Promise.resolve(handle))
    const runtime = create_bond_worker_runtime({
      detect_capabilities: () => full_caps(8),
      create_threaded_worker: threaded,
      create_scalar_worker: scalar,
    })

    const result = await runtime.compute_bonds_typed(
      typed_input(LARGE_SYSTEM_MIN_ATOMS),
    )
    // The compute is served by the scalar backend and reports it to the UI.
    expect(result.backend).toBe(`rust-wasm-scalar`)
    expect(result.table).toEqual(fixed_table)
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0)
    // Rayon pool sized clamp(hardware_concurrency - 1, 2, 8) = 7 for 8 cores.
    expect(threaded).toHaveBeenCalledWith(7)

    // A second compute reuses the scalar worker; threaded init is NOT retried
    // (exactly one threaded attempt, exactly one scalar retry — no thrash).
    const again = await runtime.compute_bonds_typed(typed_input(64))
    expect(again.backend).toBe(`rust-wasm-scalar`)
    expect(threaded).toHaveBeenCalledTimes(1)
    expect(scalar).toHaveBeenCalledTimes(1)
    expect(scalar).toHaveBeenCalledWith(1)
  })

  it(`disables large-system bonds when both rust workers fail`, async () => {
    const threaded = fail_factory(`threaded init failed`)
    const scalar = fail_factory(`scalar init failed`)
    const runtime = create_bond_worker_runtime({
      detect_capabilities: () => full_caps(8),
      create_threaded_worker: threaded,
      create_scalar_worker: scalar,
    })

    await expect(runtime.compute_bonds_typed(typed_input(LARGE_SYSTEM_MIN_ATOMS)))
      .rejects.toBeInstanceOf(BondBackendUnavailableError)
    // Disabled is terminal (design §8.3): a later compute rejects immediately
    // without re-running either init.
    await expect(runtime.compute_bonds_typed(typed_input(LARGE_SYSTEM_MIN_ATOMS)))
      .rejects.toBeInstanceOf(BondBackendUnavailableError)
    expect(threaded).toHaveBeenCalledTimes(1)
    expect(scalar).toHaveBeenCalledTimes(1)
    expect(runtime.active_backend()).toBe(`disabled`)
  })

  it(`never invokes main-thread javascript for large systems`, async () => {
    // Both rust workers dead — the orchestrated JSON path must reject with an
    // actionable error, NOT run the main-thread JS strategies.
    set_bond_worker_runtime_for_tests(create_bond_worker_runtime({
      detect_capabilities: () => full_caps(8),
      create_threaded_worker: fail_factory(`threaded init failed`),
      create_scalar_worker: fail_factory(`scalar init failed`),
    }))
    const js_spy = vi.fn(() => [])
    const original = BONDING_STRATEGIES.atom_radii
    ;(BONDING_STRATEGIES as Record<string, unknown>).atom_radii = js_spy
    try {
      await expect(
        compute_bonds_async(big_structure(LARGE_SYSTEM_MIN_ATOMS), `atom_radii`, {}),
      ).rejects.toBeInstanceOf(BondBackendUnavailableError)
      expect(js_spy).not.toHaveBeenCalled()
    } finally {
      ;(BONDING_STRATEGIES as Record<string, unknown>).atom_radii = original
    }
  })

  // ─── compatibility guards (brief: "small-system behavior unchanged") ───

  it(`keeps the main-thread javascript fallback for small systems`, async () => {
    set_bond_worker_runtime_for_tests(create_bond_worker_runtime({
      detect_capabilities: () => full_caps(8),
      create_threaded_worker: fail_factory(`threaded init failed`),
      create_scalar_worker: fail_factory(`scalar init failed`),
    }))
    const js_spy = vi.fn(() => [])
    const original = BONDING_STRATEGIES.atom_radii
    ;(BONDING_STRATEGIES as Record<string, unknown>).atom_radii = js_spy
    try {
      const bonds = await compute_bonds_async(big_structure(32), `atom_radii`, {})
      expect(bonds).toEqual([])
      expect(js_spy).toHaveBeenCalledTimes(1)
    } finally {
      ;(BONDING_STRATEGIES as Record<string, unknown>).atom_radii = original
    }
  })

  // ─── request timeout (Critical: timed-out callers MUST reject, not hang) ───

  it(`rejects the timed-out caller, terminates the worker, and re-inits fresh`, async () => {
    vi.useFakeTimers()
    try {
      // A worker that swallows every request — the wedged solid_angle /
      // WebKitGTK failure mode the request deadline exists for.
      class WedgedFakeWorker {
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: unknown) => void) | null = null
        posted: Record<string, unknown>[] = []
        terminated = false
        postMessage(data: Record<string, unknown>, _transfer?: Transferable[]): void {
          this.posted.push(data) // never replies
        }
        terminate(): void {
          this.terminated = true
        }
      }

      let runtime: BondWorkerRuntime
      const workers: WedgedFakeWorker[] = []
      const scalar = vi.fn((_thread_count: number) => {
        const fake = new WedgedFakeWorker()
        workers.push(fake)
        return Promise.resolve<BondWorkerHandle>(
          new RealBondWorkerHandle(
            fake as unknown as Worker,
            (handle) => runtime.reset(handle),
            `scalar`,
          ),
        )
      })
      runtime = create_bond_worker_runtime({
        detect_capabilities: () => ({ ...full_caps(8), cross_origin_isolated: false }),
        create_threaded_worker: fail_factory(`threaded must not be attempted`),
        create_scalar_worker: scalar,
      })

      const { handle } = await runtime.acquire(64)
      // Never `await` the request before advancing timers — pre-fix it hangs
      // FOREVER (the bug), which would hang the test too. Flag pattern instead.
      let rejection: unknown = null
      handle.request_json!({ type: `bonds` }, 1_000).catch((err) => {
        rejection = err
      })
      expect(workers).toHaveLength(1)
      expect(workers[0].posted).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1_001)

      // The timed-out caller's promise REJECTS with an actionable message
      // naming the deadline and the backend...
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toContain(`timed out after 1000ms`)
      expect((rejection as Error).message).toContain(`scalar`)
      // ...the wedged worker was terminated...
      expect(workers[0].terminated).toBe(true)
      // ...and recovery stays intact: timeout is a reset, NOT an init failure,
      // so the next acquire re-initializes a FRESH worker.
      const second = await runtime.acquire(64)
      expect(scalar).toHaveBeenCalledTimes(2)
      expect(workers).toHaveLength(2)
      expect(second.handle).not.toBe(handle)
      expect(runtime.active_backend()).toBe(`rust-wasm-scalar`)
    } finally {
      vi.useRealTimers()
    }
  })

  it(`uses scalar directly when thread capabilities are missing`, async () => {
    const threaded = vi.fn((_n: number) => Promise.resolve(fake_handle()))
    const scalar = vi.fn((_n: number) => Promise.resolve(fake_handle()))
    const runtime = create_bond_worker_runtime({
      detect_capabilities: () => ({
        ...full_caps(8),
        cross_origin_isolated: false,
      }),
      create_threaded_worker: threaded,
      create_scalar_worker: scalar,
    })
    const result = await runtime.compute_bonds_typed(typed_input(128))
    expect(result.backend).toBe(`rust-wasm-scalar`)
    expect(threaded).not.toHaveBeenCalled()
    expect(scalar).toHaveBeenCalledTimes(1)
  })
})
