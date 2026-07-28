export type RenderBackendPolicy = 'auto' | 'webgpu' | 'webgl2-wasm'

export type RenderBackendPolicyReason =
  | 'default'
  | 'forced'
  | 'empty-value'
  | 'unknown-value'

export interface RenderBackendPolicyDiagnostics {
  readonly parameter: 'catgo_renderer'
  readonly requested_value: string | null
  readonly forced: boolean
  readonly reason: RenderBackendPolicyReason
}

export interface RenderBackendPolicySelection {
  readonly policy: RenderBackendPolicy
  readonly diagnostics: Readonly<RenderBackendPolicyDiagnostics>
}

function selection(
  policy: RenderBackendPolicy,
  requested_value: string | null,
  forced: boolean,
  reason: RenderBackendPolicyReason,
): Readonly<RenderBackendPolicySelection> {
  const diagnostics = Object.freeze({
    parameter: 'catgo_renderer' as const,
    requested_value,
    forced,
    reason,
  })
  return Object.freeze({ policy, diagnostics })
}

/** Parse a renderer override without reading or mutating global URL state. */
export function parse_render_backend_policy(
  search: string,
): Readonly<RenderBackendPolicySelection> {
  const requested_value = new URLSearchParams(search).get('catgo_renderer')

  if (requested_value === null) {
    return selection('auto', null, false, 'default')
  }
  if (requested_value === '') {
    return selection('auto', '', false, 'empty-value')
  }
  if (requested_value === 'webgpu' || requested_value === 'webgl2-wasm') {
    return selection(requested_value, requested_value, true, 'forced')
  }
  return selection('auto', requested_value, false, 'unknown-value')
}
