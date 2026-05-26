import { describe, it, expect, vi } from 'vitest'
import { run_tool_loop } from '../tool-loop'
import type { LlmEvent } from '../client-llm'

function gen(...batches: LlmEvent[][]): () => AsyncGenerator<LlmEvent> {
  let call = 0
  return async function* () {
    const batch = batches[call++] ?? [{ type: `done` }]
    for (const e of batch) yield e
  }
}

describe(`run_tool_loop`, () => {
  it(`executes a read tool then finishes on plain text`, async () => {
    const transport = gen(
      [{ type: `tool_calls`, calls: [{ id: `t1`, name: `get_structure_info`, arguments: {} }] }, { type: `done` }],
      [{ type: `text`, text: `Done.` }, { type: `done` }],
    )
    const events: Array<{ type: string; [k: string]: unknown }> = []
    await run_tool_loop({
      transport,
      execute: vi.fn().mockResolvedValue(`{"num_sites":2}`),
      kind_of: () => `read`,
      request_permission: vi.fn(),
      on_event: (e) => events.push(e),
    })
    const text = events.filter((e) => e.type === `text`).map((e) => e.text as string).join(``)
    expect(text).toBe(`Done.`)
    expect(events.some((e) => e.type === `tool_end` && e.name === `get_structure_info`)).toBe(true)
  })

  it(`awaits permission for mutate tools and skips on deny`, async () => {
    const execute = vi.fn().mockResolvedValue(`{"num_sites":4}`)
    const transport = gen(
      [{ type: `tool_calls`, calls: [{ id: `t1`, name: `make_supercell`, arguments: { nx: 2, ny: 1, nz: 1 } }] }, { type: `done` }],
      [{ type: `text`, text: `ok` }, { type: `done` }],
    )
    await run_tool_loop({
      transport, execute, kind_of: () => `mutate`,
      request_permission: vi.fn().mockResolvedValue(false),
      on_event: () => {},
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it(`caps runaway loops`, async () => {
    const transport = () => (async function* () {
      yield { type: `tool_calls`, calls: [{ id: `x`, name: `get_structure_info`, arguments: {} }] } as LlmEvent
      yield { type: `done` } as LlmEvent
    })()
    const events: Array<{ type: string }> = []
    await run_tool_loop({
      transport, execute: vi.fn().mockResolvedValue(`{}`), kind_of: () => `read`,
      request_permission: vi.fn(), on_event: (e) => events.push(e), max_iterations: 3,
    })
    const toolEnds = events.filter((e) => e.type === `tool_end`).length
    expect(toolEnds).toBeLessThanOrEqual(3)
  })
})
