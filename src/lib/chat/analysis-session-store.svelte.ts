/**
 * Shared analysis session store for AI tool access.
 *
 * When DosAnalysisPane/BandAnalysisPane/CohpAnalysisPane create sessions,
 * they register them here so the AI can discover and use them.
 */

export interface AnalysisSession {
  type: 'dos' | 'bands' | 'cohp' | 'md'
  session_id: string
  /** Human label, e.g. "DOS from vaspout.h5" */
  label: string
  /** Metadata from upload response */
  meta: Record<string, unknown>
  created_at: number
}

/** Reactive list of active analysis sessions. */
export const analysis_sessions: AnalysisSession[] = $state([])

export function register_analysis_session(session: AnalysisSession): void {
  // Remove any existing session of the same type (one active per type)
  const idx = analysis_sessions.findIndex((s) => s.type === session.type)
  if (idx >= 0) analysis_sessions.splice(idx, 1)
  analysis_sessions.push(session)
}

export function unregister_analysis_session(type: 'dos' | 'bands' | 'cohp' | 'md'): void {
  const idx = analysis_sessions.findIndex((s) => s.type === type)
  if (idx >= 0) {
    _blob_store.delete(analysis_sessions[idx].session_id)
    analysis_sessions.splice(idx, 1)
  }
}

export function get_analysis_session(type: 'dos' | 'bands' | 'cohp' | 'md'): AnalysisSession | undefined {
  return analysis_sessions.find((s) => s.type === type)
}

/**
 * Non-reactive blob store for large payloads (e.g. MD trajectory base64).
 * Keeps heavy data out of Svelte's reactive proxy to avoid memory/perf issues.
 */
const _blob_store = new Map<string, Record<string, unknown>>()

/** Store a large payload blob keyed by session_id. */
export function store_session_blob(session_id: string, blob: Record<string, unknown>): void {
  _blob_store.set(session_id, blob)
}

/** Retrieve a stored blob by session_id. */
export function get_session_blob(session_id: string): Record<string, unknown> | undefined {
  return _blob_store.get(session_id)
}

/** Remove a stored blob. Called automatically on unregister. */
export function remove_session_blob(session_id: string): void {
  _blob_store.delete(session_id)
}
