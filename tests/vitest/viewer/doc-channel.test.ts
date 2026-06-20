import { describe, it, expect, vi, beforeEach } from 'vitest'
import { send_open_doc, on_open_doc, emit_docs_ready, on_docs_ready } from '../../../src/lib/viewer/doc-channel'
import type { DocRef } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const ref = (n: string): DocRef => ({
  filename: n, kind: 'text', editable: true, view: 'edit',
  origin: null, local_path: `/tmp/${n}`, inline: null,
})

// BroadcastChannel is not available in jsdom; stub it for web-path tests.
class FakeBC {
  static instances: FakeBC[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  messages: unknown[] = []
  closed = false
  constructor(public name: string) { FakeBC.instances.push(this) }
  postMessage(data: unknown) {
    this.messages.push(data)
    // Deliver to all open listeners on the same channel.
    FakeBC.instances
      .filter(bc => bc !== this && bc.name === this.name && !bc.closed && bc.onmessage)
      .forEach(bc => bc.onmessage!(new MessageEvent('message', { data })))
  }
  close() { this.closed = true }
}

beforeEach(() => {
  FakeBC.instances = []
  vi.stubGlobal('BroadcastChannel', FakeBC)
})

describe('on_open_doc / send_open_doc (web path)', () => {
  it('delivers a ref to a registered listener', async () => {
    const received: DocRef[] = []
    const off = on_open_doc((r) => received.push(r), false)
    await send_open_doc(ref('a.txt'), false)
    expect(received).toHaveLength(1)
    expect(received[0].filename).toBe('a.txt')
    off()
  })

  it('does not deliver after unsubscribe', async () => {
    const received: DocRef[] = []
    const off = on_open_doc((r) => received.push(r), false)
    off()
    await send_open_doc(ref('b.txt'), false)
    expect(received).toHaveLength(0)
  })
})

describe('on_docs_ready / emit_docs_ready (web path)', () => {
  it('calls the ready callback when docs window emits ready', async () => {
    const fired: number[] = []
    const off = on_docs_ready(() => fired.push(1), false)
    await emit_docs_ready(false)
    expect(fired).toHaveLength(1)
    off()
  })

  it('does not fire open-doc listeners for ready events', async () => {
    const docRefs: DocRef[] = []
    const off = on_open_doc((r) => docRefs.push(r), false)
    await emit_docs_ready(false)
    expect(docRefs).toHaveLength(0)
    off()
  })
})
