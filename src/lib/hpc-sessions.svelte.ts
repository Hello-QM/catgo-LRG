/**
 * Shared HPC session store — single source of truth for connected HPC sessions.
 * Both Structure page (ServerPane) and Workflow page import from here.
 */
import { fetchConnections } from '$lib/api/hpc'
import type { SchedulerType } from '$lib/api/hpc'

export interface HPCSessionInfo {
  session_id: string
  host: string
  username: string
  scheduler: SchedulerType
  conda_activate?: string
  work_root?: string
}

export const LOCAL_SESSION_ID = `__local__`

export const hpc_session_store = $state({
  sessions: [] as HPCSessionInfo[],
  loading: false,
})

/** Fetch all active HPC connections from the backend and update the store. */
export async function refresh_hpc_sessions() {
  hpc_session_store.loading = true
  try {
    const connections = await fetchConnections()
    // Deduplicate by username@host (keep first session for each unique host)
    const seen = new Set<string>()
    const unique: HPCSessionInfo[] = []
    for (const c of connections) {
      if (c.session_id === LOCAL_SESSION_ID) continue
      const key = `${c.username}@${c.host}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push({ session_id: c.session_id, host: c.host, username: c.username, scheduler: c.scheduler, work_root: c.work_root || undefined })
    }
    hpc_session_store.sessions = unique
  } catch {
    hpc_session_store.sessions = []
  } finally {
    hpc_session_store.loading = false
  }
}

/** Add a session to the store (called after successful connection in ServerPane). */
export function add_session(info: HPCSessionInfo) {
  // Deduplicate by session_id OR by username@host
  const exists = hpc_session_store.sessions.find(
    (s) => s.session_id === info.session_id || (s.host === info.host && s.username === info.username),
  )
  if (!exists) {
    hpc_session_store.sessions.push(info)
  } else {
    exists.session_id = info.session_id
    exists.scheduler = info.scheduler
    exists.work_root = info.work_root
  }
}

/** Remove a session from the store (called on disconnect in ServerPane). */
export function remove_session(session_id: string) {
  const idx = hpc_session_store.sessions.findIndex((s) => s.session_id === session_id)
  if (idx >= 0) hpc_session_store.sessions.splice(idx, 1)
}
