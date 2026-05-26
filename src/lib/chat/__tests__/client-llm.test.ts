import { describe, it, expect } from 'vitest'
import { parse_openai_stream, type LlmEvent } from '../client-llm'

function sse(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder()
  const body = lines.map((l) => `data: ${l}\n\n`).join(``) + `data: [DONE]\n\n`
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(body))
      c.close()
    },
  })
  return stream.getReader()
}

describe(`parse_openai_stream`, () => {
  it(`assembles text deltas`, async () => {
    const events: LlmEvent[] = []
    for await (const e of parse_openai_stream(sse([
      JSON.stringify({ choices: [{ delta: { content: `Hel` } }] }),
      JSON.stringify({ choices: [{ delta: { content: `lo` } }] }),
    ]))) events.push(e)
    const text = events
      .filter((e): e is Extract<LlmEvent, { type: `text` }> => e.type === `text`)
      .map((e) => e.text)
      .join(``)
    expect(text).toBe(`Hello`)
  })

  it(`assembles tool_calls split across chunks`, async () => {
    const events: LlmEvent[] = []
    for await (const e of parse_openai_stream(sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c1`, function: { name: `make_supercell`, arguments: `{"nx":2,` } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"ny":1,"nz":1}` } }] } }] }),
      JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
    ]))) events.push(e)
    const tc = events.find((e): e is Extract<LlmEvent, { type: `tool_calls` }> => e.type === `tool_calls`)
    expect(tc?.calls[0]).toEqual({ id: `c1`, name: `make_supercell`, arguments: { nx: 2, ny: 1, nz: 1 } })
  })

  it(`yields an error event (not a throw) on malformed tool-call args`, async () => {
    const events: LlmEvent[] = []
    await expect((async () => {
      for await (const e of parse_openai_stream(sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c1`, function: { name: `x`, arguments: `{"nx":` } }] } }] }),
        JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
      ]))) events.push(e)
    })()).resolves.not.toThrow()
    expect(events.some((e) => e.type === `error`)).toBe(true)
    expect(events.some((e) => e.type === `done`)).toBe(true)
  })
})
