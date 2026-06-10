import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression test for the "node disappears after run" bug.
 *
 * run_workflow used to call db.flush_now() — writing the browser's WASM
 * sql.js snapshot (a whole-file image loaded at page start) over the on-disk
 * SQLite file. Any rows the backend persisted after the snapshot was loaded
 * (new workflows, graph updates with new nodes) were rolled back, so a
 * geo_opt node added before Run vanished after the run, and freshly created
 * workflows died with "Workflow not found".
 *
 * The fix: run_workflow never flushes the snapshot. Callers with editor
 * state pass the authoritative graph_json, which is synced to the backend
 * via POST /api/workflow/.
 */

const flush_now = vi.fn()
const db_get_current = vi.fn(async () => ({ path: 'server/data/catgo_results.db', name: 'catgo_results' }))

vi.mock('$lib/io/tauri', () => ({ check_tauri: () => false }))
vi.mock('../config', () => ({
  API_BASE: 'http://test/api',
  desktop_backend_available: async () => true,
}))
vi.mock('../db-wasm', () => ({
  flush_now,
  db_get_current,
}))

// Make getLocal() take the __CATGO_DESKTOP__ → db-wasm branch
;(globalThis as Record<string, unknown>).__CATGO_DESKTOP__ = true

import { run_workflow } from '../workflow'

function mock_fetch_ok() {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ status: 'running', workflow_id: 'wf-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
  return calls
}

describe('run_workflow snapshot safety', () => {
  beforeEach(() => {
    flush_now.mockClear()
    db_get_current.mockClear()
  })

  it('never flushes the WASM snapshot over the on-disk DB', async () => {
    mock_fetch_ok()
    await run_workflow('wf-1', { execution_mode: 'local' } as never, '{"nodes":[],"edges":[]}')
    expect(flush_now).not.toHaveBeenCalled()
  })

  it('syncs the caller-provided graph_json to the backend before running', async () => {
    const calls = mock_fetch_ok()
    const graph = JSON.stringify({ nodes: [{ id: 'n1', type: 'geo_opt' }], edges: [] })
    await run_workflow('wf-1', { execution_mode: 'local' } as never, graph)

    const sync = calls.find(c => c.url === 'http://test/api/workflow/' && c.init?.method === 'POST')
    expect(sync).toBeDefined()
    expect(JSON.parse(String(sync!.init!.body)).graph_json).toBe(graph)

    const run = calls.find(c => c.url.endsWith('/workflow/wf-1/run'))
    expect(run).toBeDefined()
  })

  it('does not read the workflow back from the (possibly stale) local DB when graph is provided', async () => {
    const calls = mock_fetch_ok()
    await run_workflow('wf-1', { execution_mode: 'local' } as never, '{"nodes":[],"edges":[]}')
    // metadata fetch may hit the backend, but no GET should be needed pre-sync
    const gets = calls.filter(c => !c.init?.method || c.init.method === 'GET')
    for (const g of gets) {
      expect(g.url).not.toContain('__db')
    }
  })
})
