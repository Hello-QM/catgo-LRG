import type { DocRef } from './doc-viewer-state.svelte'

const PENDING_KEY = `catgo-docs-pending`
const INLINE_PREFIX = `catgo-docs-inline-`
const CHANNEL = `catgo-docs`
const EVENT = `catgo-open-doc`

export function enqueue_pending(ref: DocRef): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const arr: DocRef[] = raw ? JSON.parse(raw) : []
    arr.push(ref)
    localStorage.setItem(PENDING_KEY, JSON.stringify(arr))
  } catch {
    // Non-fatal: the live channel still delivers to an already-open window.
  }
}

export function drain_pending(): DocRef[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    localStorage.removeItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as DocRef[]) : []
  } catch {
    return []
  }
}

export async function send_open_doc(ref: DocRef, is_tauri: boolean): Promise<void> {
  if (is_tauri) {
    try {
      const { emit } = await import(`@tauri-apps/api/event`)
      await emit(EVENT, ref)
      return
    } catch {
      // fall through to BroadcastChannel
    }
  }
  try {
    const bc = new BroadcastChannel(CHANNEL)
    bc.postMessage(ref)
    bc.close()
  } catch {
    // Web with no BroadcastChannel: the pending queue + mount drain covers it.
  }
}

export function on_open_doc(cb: (ref: DocRef) => void, is_tauri: boolean): () => void {
  if (is_tauri) {
    let un: (() => void) | null = null
    let cancelled = false
    import(`@tauri-apps/api/event`).then(({ listen }) => {
      if (cancelled) return
      listen<DocRef>(EVENT, (e) => cb(e.payload)).then((u) => {
        if (cancelled) u()
        else un = u
      })
    })
    return () => { cancelled = true; if (un) un() }
  }
  const bc = new BroadcastChannel(CHANNEL)
  bc.onmessage = (e) => cb(e.data as DocRef)
  return () => bc.close()
}

/** Remove inline-content keys not referenced by any live tab (orphans from refs that never loaded). */
export function sweep_inline_keys(keep: string[]): void {
  try {
    const keepSet = new Set(keep)
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(INLINE_PREFIX) && !keepSet.has(k)) toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
  } catch {
    // non-fatal
  }
}
