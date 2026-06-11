/**
 * Live multi-cluster registry — which clusters the user is logged into RIGHT
 * NOW, and which one is "active" (drives the Files / Jobs / chat panels).
 *
 * Complements `sessions.ts` (endpoint→session_id reuse cache): sessions.ts
 * remembers connections that can be silently reattached; this registry holds
 * the user-visible list of clusters that are currently attached to the
 * workspace UI. Module-level `$state` so it survives component remounts —
 * same lifetime model as sessions.ts / terminal-tabs (a fresh app launch
 * starts empty, which is correct: SSH sessions cannot outlive the process).
 */

export type LiveCluster = {
  /** Endpoint key, `host:port:user` (see sessions.endpointKey). */
  key: string
  /** The live russh session id on the Rust side. */
  session_id: string
  host: string
  port: number
  username: string
  /** Display label: the saved connection's nickname, else `user@host`. */
  label: string
}

export const clusters = $state({
  list: [] as LiveCluster[],
  /** Endpoint key of the cluster the workspace panels operate on. */
  active_key: null as string | null,
})

/** Add (or refresh) a cluster and make it the active one. */
export function register_cluster(c: LiveCluster): void {
  const idx = clusters.list.findIndex((x) => x.key === c.key)
  if (idx >= 0) clusters.list[idx] = c
  else clusters.list.push(c)
  clusters.active_key = c.key
}

/** Remove a cluster (on eject). Returns the next cluster to activate, if any. */
export function remove_cluster(key: string): LiveCluster | null {
  const idx = clusters.list.findIndex((x) => x.key === key)
  if (idx >= 0) clusters.list.splice(idx, 1)
  if (clusters.active_key === key) {
    const next = clusters.list[Math.min(idx, clusters.list.length - 1)] ?? null
    clusters.active_key = next?.key ?? null
    return next
  }
  return get_active_cluster()
}

export function set_active_cluster(key: string): LiveCluster | null {
  const c = clusters.list.find((x) => x.key === key) ?? null
  if (c) clusters.active_key = c.key
  return c
}

export function get_active_cluster(): LiveCluster | null {
  return clusters.list.find((x) => x.key === clusters.active_key) ?? null
}

/** Drop a cluster whose session turned out dead (without touching the rest). */
export function drop_dead_cluster(session_id: string): void {
  const c = clusters.list.find((x) => x.session_id === session_id)
  if (c) remove_cluster(c.key)
}
