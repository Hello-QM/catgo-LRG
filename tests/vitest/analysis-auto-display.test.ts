import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { start_mcp_bridge, type McpBridgeDeps } from '$lib/structure/controllers/tool-handler'

// The SSE `analysis` event is how a session an AGENT created reaches the pane:
// the electronic panes otherwise adopt a session only on human file upload, so a
// spectrum CatBot computed would exist only as text in a tool response.

type Listener = (ev: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Listener[]>()
  closed = false
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  close() {
    this.closed = true
  }
  emit(type: string, data: unknown) {
    const payload = { data: typeof data === `string` ? data : JSON.stringify(data) } as MessageEvent
    for (const fn of this.listeners.get(type) ?? []) fn(payload)
  }
}

async function bridge(overrides: Partial<McpBridgeDeps> = {}) {
  const opened: { kind: string; session: Record<string, unknown> }[] = []
  const deps: McpBridgeDeps = {
    panel_id: `structure-1`,
    get_structure: () => undefined,
    set_structure: () => {},
    inc_center_camera: () => {},
    get_selected_sites: () => [],
    get_wrapper: () => undefined,
    open_analysis: (kind, session) => { opened.push({ kind, session }) },
    ...overrides,
  }
  const handle = start_mcp_bridge(deps)
  // the bridge opens its EventSource only after an initial `POST /view/reset`
  // resolves, so the stub instance does not exist synchronously
  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
  const es = FakeEventSource.instances.at(-1)!
  return { opened, es, handle }
}

describe(`analysis auto-display over SSE`, () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal(`EventSource`, FakeEventSource)
    // the bridge also polls screenshots / pushes state; keep those inert
    vi.stubGlobal(`fetch`, vi.fn(async () => new Response(`{}`, { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it(`hands a DOS session announced by the backend to the pane opener`, async () => {
    const { opened, es, handle } = await bridge()
    const session = { session_id: `dos-42`, efermi: -2.5, elements: [`Pt`] }

    es.emit(`analysis`, { kind: `dos`, session })

    expect(opened).toEqual([{ kind: `dos`, session }])
    handle.cleanup()
  })

  it(`carries bands and cohp too — all three electronic panes, one event`, async () => {
    const { opened, es, handle } = await bridge()

    es.emit(`analysis`, { kind: `bands`, session: { session_id: `b-1` } })
    es.emit(`analysis`, { kind: `cohp`, session: { session_id: `c-1` } })

    expect(opened.map((o) => o.kind)).toEqual([`bands`, `cohp`])
    handle.cleanup()
  })

  it(`ignores an event with no adoptable session — an empty pane is worse than none`, async () => {
    const { opened, es, handle } = await bridge()

    es.emit(`analysis`, { kind: `dos` })
    es.emit(`analysis`, { kind: `dos`, session: {} })
    es.emit(`analysis`, { kind: ``, session: { session_id: `x` } })
    es.emit(`analysis`, `not json {`)

    expect(opened).toEqual([])
    handle.cleanup()
  })

  it(`does not throw when the viewer supplies no opener (preview/embed panes)`, async () => {
    const { es, handle } = await bridge({ open_analysis: undefined })

    expect(() => es.emit(`analysis`, { kind: `dos`, session: { session_id: `d` } })).not.toThrow()
    handle.cleanup()
  })

  it(`subscribes on the panel's own channel`, async () => {
    const { es, handle } = await bridge()
    expect(es.url).toContain(`panel_id=structure-1`)
    handle.cleanup()
    expect(es.closed).toBe(true)
  })
})
