import type { DocRef } from './doc-viewer-state.svelte'

const CHANNEL = `catgo-docs`
const READY_CHANNEL = `catgo-docs-ready`
const EVENT = `catgo-open-doc`
const READY_EVENT = `catgo-docs-ready`

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
    // BroadcastChannel unavailable: handshake path (on_docs_ready) covers cold-open.
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

/** Emitted by the docs window on mount so the opener can deliver the queued ref. */
export async function emit_docs_ready(is_tauri: boolean): Promise<void> {
  if (is_tauri) {
    try {
      const { emit } = await import(`@tauri-apps/api/event`)
      await emit(READY_EVENT)
      return
    } catch {
      // fall through to BroadcastChannel
    }
  }
  try {
    const bc = new BroadcastChannel(READY_CHANNEL)
    bc.postMessage({ type: READY_EVENT })
    bc.close()
  } catch {
    // non-fatal
  }
}

/** Listen for the docs-ready handshake. Returns an unsubscribe function. */
export function on_docs_ready(cb: () => void, is_tauri: boolean): () => void {
  if (is_tauri) {
    let un: (() => void) | null = null
    let cancelled = false
    import(`@tauri-apps/api/event`).then(({ listen }) => {
      if (cancelled) return
      listen(READY_EVENT, () => cb()).then((u) => {
        if (cancelled) u()
        else un = u
      })
    })
    return () => { cancelled = true; if (un) un() }
  }
  const bc = new BroadcastChannel(READY_CHANNEL)
  bc.onmessage = () => cb()
  return () => bc.close()
}
