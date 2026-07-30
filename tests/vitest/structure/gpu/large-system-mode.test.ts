import { describe, it, expect, vi } from 'vitest'
import {
  create_large_system_mode,
  result_to_connectivity,
  to_compute_options,
} from '$lib/structure/gpu/large-system-mode.svelte'

describe(`result_to_connectivity`, () => {
  it(`translates compute pairs into bond_connectivity entries`, () => {
    const conn = result_to_connectivity({
      count: 2,
      raw_count: 2,
      overflowed: false,
      pairs: [
        { a: 0, b: 1, jimage: [0, 0, 0] },
        { a: 1, b: 2, jimage: [1, 0, 0] },
      ],
    })
    expect(conn).toEqual([
      { site_idx_1: 0, site_idx_2: 1, strength: 1, jimage: [0, 0, 0] },
      { site_idx_1: 1, site_idx_2: 2, strength: 1, jimage: [1, 0, 0] },
    ])
  })
  it(`only emits 'count' entries even if pairs array is longer`, () => {
    const conn = result_to_connectivity({
      count: 1, raw_count: 5, overflowed: true,
      pairs: [ { a: 0, b: 1, jimage: [0, 0, 0] }, { a: 2, b: 3, jimage: [0, 0, 0] } ],
    })
    expect(conn).toHaveLength(1)
  })
})

describe(`create_large_system_mode`, () => {
  it(`refuses to enable when WebGPU is unavailable and signals fallback`, () => {
    const on_fallback = vi.fn()
    const mode = create_large_system_mode({ has_webgpu: false, on_fallback })
    expect(mode.available).toBe(false)
    expect(mode.enable()).toBe(false)
    expect(mode.enabled).toBe(false)
    expect(on_fallback).toHaveBeenCalledOnce()
  })
  it(`enables when WebGPU is available`, () => {
    const on_fallback = vi.fn()
    const mode = create_large_system_mode({ has_webgpu: true, on_fallback })
    expect(mode.enable()).toBe(true)
    expect(mode.enabled).toBe(true)
    mode.disable()
    expect(mode.enabled).toBe(false)
    expect(on_fallback).not.toHaveBeenCalled()
  })
})

describe(`to_compute_options`, () => {
  it(`maps legacy fixed-pad options to compute params`, () => {
    expect(to_compute_options({ max_bond_dist: 2.6, tolerance: 0.3 }))
      .toEqual({ tolerance: 0.3, max_bond_dist: 2.6, min_bond_dist: 0.1 })
  })
  it(`fills the original large-system defaults when options are missing`, () => {
    expect(to_compute_options({}))
      .toEqual({ tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 })
  })
  it(`honors a custom min_bond_dist when provided`, () => {
    expect(to_compute_options({ min_bond_dist: 0.2 }))
      .toEqual({ tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.2 })
  })
  it(`normalizes an invalid tolerance before sharing it with GPU and Rust fallback paths`, () => {
    expect(to_compute_options({ tolerance: -0.2 }).tolerance).toBe(0)
    expect(to_compute_options({ tolerance: Number.NaN }).tolerance).toBe(0.45)
  })
  it(`accepts legacy min_dist as an alias only when min_bond_dist is absent`, () => {
    expect(to_compute_options({ min_dist: 0.25 }))
      .toEqual({ tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.25 })
  })
})
