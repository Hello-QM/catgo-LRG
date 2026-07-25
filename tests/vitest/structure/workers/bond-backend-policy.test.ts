import { describe, expect, it } from 'vitest'
import {
  type BondBackendCapabilities,
  plan_bond_dispatch,
  select_rust_bond_backend,
} from '$lib/structure/workers/bond-backend-policy'
import { detect_wasm_atomics } from '$lib/structure/workers/wasm-thread-capability'

const ortho = (a: number, b: number, c: number) =>
  new Float32Array([a, 0, 0, 0, b, 0, 0, 0, c])

// A large, well-shaped periodic cell: every grid dim = floor(40/3) = 13 ≥ 3, so
// the grid path is usable and storage is tiny.
const big_grid_input = (atom_count: number, extra: Partial<{
  direct_limit: number
  max_storage_bytes: number
}> = {}) => ({
  periodic: true,
  lattice: ortho(40, 40, 40),
  max_bond_dist: 3,
  positions: new Float32Array(0),
  n: atom_count,
  atom_count,
  direct_limit: extra.direct_limit ?? 1024,
  max_storage_bytes: extra.max_storage_bytes ?? (1 << 30),
})

const full_caps = (hardware_concurrency: number): BondBackendCapabilities => ({
  cross_origin_isolated: true,
  shared_array_buffer: true,
  wasm_atomics: true,
  hardware_concurrency,
})

describe(`plan_bond_dispatch`, () => {
  it(`never selects all-pairs for 19_968 atoms`, () => {
    // Even with an absurd direct_limit, a 19_968-atom system must never route to
    // the direct all-pairs plan — the hard 1024 cap forbids it.
    const plan = plan_bond_dispatch(
      big_grid_input(19_968, { direct_limit: 1_000_000 }),
    )
    expect(plan.kind).not.toBe(`direct`)
    expect(plan.kind).toBe(`gpu-grid`)
  })

  it(`allows direct all-pairs only up to 1024 atoms`, () => {
    expect(plan_bond_dispatch(big_grid_input(1024)).kind).toBe(`direct`)
    expect(plan_bond_dispatch(big_grid_input(1025)).kind).not.toBe(`direct`)
  })

  it(`routes an over-budget grid to rust wasm (grid-storage-limit)`, () => {
    const plan = plan_bond_dispatch(
      big_grid_input(19_968, { max_storage_bytes: 1 }),
    )
    expect(plan).toEqual({ kind: `rust-wasm`, reason: `grid-storage-limit` })
  })
})

describe(`detect_wasm_atomics`, () => {
  // JS `Atomics` + `SharedArrayBuffer` are present in every scope below — the
  // point is that the wasm probe must consult `WebAssembly.validate`, not those
  // (nearly always co-present) JS globals.
  const validate_scope = (validate: (bytes: BufferSource) => boolean) => ({
    Atomics: {},
    SharedArrayBuffer: function () {},
    WebAssembly: { validate },
  })

  it(`is false when the engine rejects shared-memory wasm despite Atomics + SAB`, () => {
    // Exactly the case the old Atomics/SAB proxy check got wrong.
    expect(detect_wasm_atomics(validate_scope(() => false))).toBe(false)
  })

  it(`is true when validate accepts the shared-memory probe module`, () => {
    let probed: BufferSource | undefined
    const scope = validate_scope((bytes) => {
      probed = bytes
      return true
    })
    expect(detect_wasm_atomics(scope)).toBe(true)
    // The probe must actually hand validate a wasm byte module.
    expect(probed).toBeInstanceOf(Uint8Array)
  })

  it(`is false when WebAssembly is missing from the scope`, () => {
    expect(detect_wasm_atomics({})).toBe(false)
  })

  it(`is false when validate throws`, () => {
    expect(
      detect_wasm_atomics(validate_scope(() => {
        throw new Error(`boom`)
      })),
    ).toBe(false)
  })

  it(`probes the real global scope without throwing (smoke)`, () => {
    expect(typeof detect_wasm_atomics()).toBe(`boolean`)
  })
})

describe(`select_rust_bond_backend`, () => {
  it(`selects threads only with coi sab atomics and two cores`, () => {
    // All four conditions present ⇒ threads.
    expect(select_rust_bond_backend(full_caps(2), 19_968).kind).toBe(
      `rust-wasm-threads`,
    )
    // Drop any single capability ⇒ scalar.
    expect(
      select_rust_bond_backend(
        { ...full_caps(2), cross_origin_isolated: false },
        19_968,
      ).kind,
    ).toBe(`rust-wasm-scalar`)
    expect(
      select_rust_bond_backend(
        { ...full_caps(2), shared_array_buffer: false },
        19_968,
      ).kind,
    ).toBe(`rust-wasm-scalar`)
    expect(
      select_rust_bond_backend(
        { ...full_caps(2), wasm_atomics: false },
        19_968,
      ).kind,
    ).toBe(`rust-wasm-scalar`)
    // Only one logical core ⇒ scalar (no useful parallelism).
    expect(select_rust_bond_backend(full_caps(1), 19_968).kind).toBe(
      `rust-wasm-scalar`,
    )
  })

  it(`leaves one ui core and caps the pool at eight`, () => {
    // thread_count = clamp(hardware_concurrency - 1, 1, 8).
    expect(select_rust_bond_backend(full_caps(2), 19_968).thread_count).toBe(1)
    expect(select_rust_bond_backend(full_caps(4), 19_968).thread_count).toBe(3)
    expect(select_rust_bond_backend(full_caps(9), 19_968).thread_count).toBe(8)
    expect(select_rust_bond_backend(full_caps(16), 19_968).thread_count).toBe(
      8,
    )
    // Scalar backend still reports a usable single-thread count.
    expect(select_rust_bond_backend(full_caps(1), 19_968).thread_count).toBe(1)
  })
})
