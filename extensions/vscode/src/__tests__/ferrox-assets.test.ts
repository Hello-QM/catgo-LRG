import { describe, expect, test, vi } from 'vitest'
import { select_scalar_ferrox_wasm } from '../ferrox-assets'

describe(`select_scalar_ferrox_wasm`, () => {
  test(`selects scalar when threaded artifact is listed first`, () => {
    const scalar = {
      filename: `ferrox_bg-scalar.wasm`,
      buffer: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
    }
    const threaded = {
      filename: `ferrox_bg-threaded.wasm`,
      buffer: Uint8Array.from([
        0, 97, 115, 109, 1, 0, 0, 0,
        2, 11, 1, 1, 109, 3, 109, 101, 109, 2, 3, 1, 1,
      ]),
    }

    expect(select_scalar_ferrox_wasm([threaded, scalar])).toBe(scalar)
  })

  test(`skips invalid artifacts`, () => {
    const on_invalid = vi.fn()
    const invalid = {
      filename: `ferrox_bg-invalid.wasm`,
      buffer: Uint8Array.from([0]),
    }
    const scalar = {
      filename: `ferrox_bg-scalar.wasm`,
      buffer: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
    }

    expect(select_scalar_ferrox_wasm([invalid, scalar], on_invalid)).toBe(scalar)
    expect(on_invalid).toHaveBeenCalledWith(invalid, expect.any(Error))
  })
})
