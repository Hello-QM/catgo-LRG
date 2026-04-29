/**
 * External change detection (MCP / other tabs) for workflow editor.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 */

export interface ChangeDetection {
  readonly known_updated_at: string | null
  readonly external_change_detected: boolean

  set_known_updated_at(v: string | null): void
  set_external_change_detected(v: boolean): void
}

export function create_change_detection(): ChangeDetection {
  let known_updated_at = $state<string | null>(null)
  let external_change_detected = $state(false)

  return {
    get known_updated_at() { return known_updated_at },
    get external_change_detected() { return external_change_detected },

    set_known_updated_at(v) { known_updated_at = v },
    set_external_change_detected(v) { external_change_detected = v },
  }
}
