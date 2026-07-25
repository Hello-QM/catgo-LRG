import { describe, expect, it } from 'vitest'
import {
  create_bond_run_controller,
  next_pow2,
} from '$lib/structure/gpu/bond-diagnostics'

// Lossless overflow publication (design §8.2): the run controller decides,
// deterministically, whether one bond-compute run may be PUBLISHED (complete)
// or must grow its sizing and RERUN. An incomplete candidate is never
// published, and an allocation-limit failure never replaces the active graph.
describe(`bond run controller (overflow publication)`, () => {
  const make = () =>
    create_bond_run_controller({ cell_stride: 64, pair_capacity: 4096 })

  it(`retries cell overflow without publishing the candidate graph`, () => {
    const ctl = make()
    ctl.begin_graph()
    ctl.record_dispatch({ clear: true, bin: true, detect: true }, [8, 8, 8])
    // A cell observed 96 atoms but the stride only stores 64 ⇒ atoms were
    // dropped ⇒ the candidate is chemically incomplete. Grow the stride to
    // nextPow2(96) = 128 and rerun; do NOT publish.
    const decision = ctl.observe({ raw_count: 100, max_observed_occupancy: 96 })
    expect(decision).toEqual({ action: `retry`, cell_stride: 128, pair_capacity: 4096 })
    const diag = ctl.diagnostics()
    expect(diag.graph_version).toBe(0) // candidate NOT published
    expect(diag.overflow).toEqual({ cells: true, pairs: false, retries: 1 })
    expect(diag.grid.cell_stride).toBe(128)
    expect(diag.grid.max_observed_occupancy).toBe(96)
    // The complete rerun (occupancy now fits the grown stride) publishes.
    ctl.record_dispatch({ clear: true, bin: true, detect: true }, [8, 8, 8])
    expect(ctl.observe({ raw_count: 100, max_observed_occupancy: 96 }))
      .toEqual({ action: `publish` })
    expect(ctl.diagnostics().graph_version).toBe(1)
  })

  it(`grows pair capacity and publishes the complete rerun`, () => {
    const ctl = make()
    ctl.begin_graph()
    ctl.record_dispatch({ clear: true, bin: true, detect: true }, [10, 10, 10])
    // The shader atomically counted 5000 raw pairs but only 4096 slots exist ⇒
    // pairs were dropped. Grow capacity to nextPow2(5000) = 8192 and rerun.
    expect(ctl.observe({ raw_count: 5000, max_observed_occupancy: 32 }))
      .toEqual({ action: `retry`, cell_stride: 64, pair_capacity: 8192 })
    ctl.record_dispatch({ clear: true, bin: true, detect: true }, [10, 10, 10])
    expect(ctl.observe({ raw_count: 5000, max_observed_occupancy: 32 }))
      .toEqual({ action: `publish` })
    const diag = ctl.diagnostics()
    expect(diag.graph_version).toBe(1)
    expect(diag.pairs).toEqual({ raw: 5000, capacity: 8192 })
    expect(diag.overflow).toEqual({ cells: false, pairs: false, retries: 1 })
    expect(diag.dispatches).toEqual({ clear: 2, bin: 2, detect: 2 })
    expect(diag.grid.dims).toEqual([10, 10, 10])
  })

  it(`reports allocation-limit instead of clamping`, () => {
    const ctl = create_bond_run_controller({
      cell_stride: 64,
      pair_capacity: 4096,
      limits: { max_pair_capacity: 8192, max_cell_stride: 2048, max_retries: 8 },
    })
    ctl.begin_graph()
    ctl.record_dispatch({ detect: true })
    // Growing to nextPow2(10000) = 16384 would exceed the 8192 allocation
    // limit: report the error — never clamp to an incomplete graph, and never
    // replace the active one.
    const decision = ctl.observe({ raw_count: 10_000, max_observed_occupancy: 8 })
    expect(decision.action).toBe(`allocation-limit`)
    if (decision.action === `allocation-limit`) {
      expect(decision.message).toMatch(/pair/i)
    }
    const diag = ctl.diagnostics()
    expect(diag.graph_version).toBe(0) // the active graph is never replaced
    expect(diag.overflow.pairs).toBe(true)
    expect(diag.pairs.capacity).toBe(4096) // NOT silently grown past the limit
  })

  it(`next_pow2 is exact at powers of two`, () => {
    expect(next_pow2(1)).toBe(1)
    expect(next_pow2(2)).toBe(2)
    expect(next_pow2(3)).toBe(4)
    expect(next_pow2(4096)).toBe(4096)
    expect(next_pow2(4097)).toBe(8192)
  })
})
