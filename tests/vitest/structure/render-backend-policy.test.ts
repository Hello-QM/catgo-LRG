import { describe, expect, it } from 'vitest'
import { parse_render_backend_policy } from '$lib/structure/render-backend-policy'

describe('parse_render_backend_policy', () => {
  it('defaults to auto when the query parameter is absent', () => {
    expect(parse_render_backend_policy('?other=value')).toEqual({
      policy: 'auto',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: null,
        forced: false,
        reason: 'default',
      },
    })
  })

  it('accepts the exact webgpu forced value', () => {
    expect(parse_render_backend_policy('?catgo_renderer=webgpu')).toEqual({
      policy: 'webgpu',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: 'webgpu',
        forced: true,
        reason: 'forced',
      },
    })
  })

  it('accepts the exact webgl2-wasm forced value', () => {
    expect(parse_render_backend_policy('?catgo_renderer=webgl2-wasm')).toEqual({
      policy: 'webgl2-wasm',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: 'webgl2-wasm',
        forced: true,
        reason: 'forced',
      },
    })
  })

  it('falls back to auto with an empty-value diagnostic', () => {
    expect(parse_render_backend_policy('?catgo_renderer=')).toEqual({
      policy: 'auto',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: '',
        forced: false,
        reason: 'empty-value',
      },
    })
  })

  it.each(['auto', 'WebGPU', 'webgpu ', 'webgl2', 'unknown'])(
    'rejects non-exact value %j with an unknown-value diagnostic',
    (requested_value) => {
      expect(
        parse_render_backend_policy(
          `?catgo_renderer=${encodeURIComponent(requested_value)}`,
        ),
      ).toEqual({
        policy: 'auto',
        diagnostics: {
          parameter: 'catgo_renderer',
          requested_value,
          forced: false,
          reason: 'unknown-value',
        },
      })
    },
  )

  it('returns a read-only selection and diagnostics object', () => {
    const selection = parse_render_backend_policy('?catgo_renderer=webgpu')

    expect(Object.isFrozen(selection)).toBe(true)
    expect(Object.isFrozen(selection.diagnostics)).toBe(true)
  })
})
