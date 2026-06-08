import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the dry-run API client so simulate_run never touches the network.
const dry_run_workflow = vi.fn<(...a: any[]) => any>()
vi.mock('$lib/api/workflow-v2', () => ({ dry_run_workflow: (...a: any[]) => dry_run_workflow(...a) }))

// Mock the upstream-structure resolver so we control what goes into the
// `structures` map. (The real one BFS-walks edges; here we just stub it.)
const resolve_input_structure = vi.fn<(...a: any[]) => string | null>(() => null)
vi.mock('../graph-model', async (orig) => {
  const actual = (await (orig() as Promise<Record<string, unknown>>)) as Record<string, unknown>
  return { ...actual, resolve_input_structure: (...a: any[]) => resolve_input_structure(...a) }
})

import { create_workflow_execution } from '../workflow-execution.svelte'
import type { WfNode, WfEdge } from '../graph-model'

function node(id: string, type = `vasp_relax`, params: Record<string, unknown> = {}): WfNode {
  return { id, type, x: 0, y: 0, params }
}
function edge(from: string, to: string): WfEdge {
  return { id: `${from}->${to}`, from, to, fromH: `out-0`, toH: `in-0` }
}

describe(`simulate_run (real dry-run)`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dry_run_workflow.mockReset()
    resolve_input_structure.mockReset()
    resolve_input_structure.mockReturnValue(null)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`maps ok=true→completed, ok=false→failed(+error), ok=null→skipped(+reason)`, async () => {
    const nodes = [node(`a`), node(`b`), node(`c`)]
    const edges = [edge(`a`, `b`), edge(`b`, `c`)]
    dry_run_workflow.mockResolvedValue({
      valid: false,
      results: {
        a: { ok: true },
        b: { ok: false, error: `missing POTCAR for Ir` },
        c: { ok: null, skipped: `upstream structure not available` },
      },
      graph_errors: [],
    })

    const exec = create_workflow_execution()
    exec.simulate_run(nodes, edges)

    // Drain the visual cadence timers and the awaited promise.
    await vi.runAllTimersAsync()

    expect(exec.node_statuses.a).toBe(`completed`)
    expect(exec.node_statuses.b).toBe(`failed`)
    expect(exec.node_statuses.c).toBe(`skipped`) // NOT failed — the #225 invariant
    expect(exec.node_errors.b).toBe(`missing POTCAR for Ir`)
    expect(exec.node_errors.c).toBe(`upstream structure not available`)
    expect(exec.node_errors.a).toBeUndefined()
    expect(exec.sim_running).toBe(false)
  })

  it(`builds structures map: own structure_json wins, else upstream resolver`, async () => {
    const nodes = [
      node(`s`, `structure_input`, { structure_json: `OWN_POSCAR` }),
      node(`calc`, `vasp_relax`),
    ]
    const edges = [edge(`s`, `calc`)]
    resolve_input_structure.mockImplementation((id: string) =>
      id === `calc` ? `UPSTREAM_POSCAR` : null,
    )
    dry_run_workflow.mockResolvedValue({ valid: true, results: { s: { ok: true }, calc: { ok: true } }, graph_errors: [] })

    const exec = create_workflow_execution()
    exec.simulate_run(nodes, edges)
    await vi.runAllTimersAsync()

    const passed = dry_run_workflow.mock.calls[0][2] as Record<string, string>
    expect(passed.s).toBe(`OWN_POSCAR`)          // own structure_json wins
    expect(passed.calc).toBe(`UPSTREAM_POSCAR`)  // resolved upstream
  })

  it(`surfaces graph_errors: involved nodes failed + execution_error set`, async () => {
    const nodes = [node(`x`), node(`y`)]
    const edges = [edge(`x`, `y`), edge(`y`, `x`)]
    dry_run_workflow.mockResolvedValue({
      valid: false,
      results: {},
      graph_errors: [`cycle detected involving x and y`],
    })

    const exec = create_workflow_execution()
    exec.simulate_run(nodes, edges)
    await vi.runAllTimersAsync()

    expect(exec.node_statuses.x).toBe(`failed`)
    expect(exec.node_statuses.y).toBe(`failed`)
    expect(exec.execution_error).toContain(`cycle detected`)
  })

  it(`toggle while running clears statuses and errors`, async () => {
    const nodes = [node(`a`)]
    const edges: WfEdge[] = []
    // Never resolves — keeps sim_running true so the toggle path is exercised.
    dry_run_workflow.mockReturnValue(new Promise(() => {}))

    const exec = create_workflow_execution()
    exec.simulate_run(nodes, edges)
    expect(exec.sim_running).toBe(true)

    exec.simulate_run(nodes, edges) // toggle off
    expect(exec.sim_running).toBe(false)
    expect(exec.node_statuses).toEqual({})
    expect(exec.node_errors).toEqual({})
  })
})
