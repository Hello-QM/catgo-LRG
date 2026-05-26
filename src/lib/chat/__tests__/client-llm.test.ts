import { describe, it, expect } from 'vitest'
import { parse_openai_stream, to_openai_message, type LlmEvent } from '../client-llm'
import type { ChatMessage } from '../types'

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

describe(`to_openai_message`, () => {
  it(`maps a string-content message unchanged`, () => {
    const m: ChatMessage = { role: `user`, content: `hi`, timestamp: 0 }
    expect(to_openai_message(m)).toEqual({ role: `user`, content: `hi` })
  })

  it(`maps a tool_use block to an assistant tool_calls message`, () => {
    const m: ChatMessage = {
      role: `assistant`,
      content: [{ type: `tool_use`, id: `a`, name: `f`, input: { x: 1 } }],
      timestamp: 0,
    }
    const out = to_openai_message(m) as {
      role: string
      content: null
      tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[]
    }
    expect(out.role).toBe(`assistant`)
    expect(out.content).toBeNull()
    expect(out.tool_calls[0].id).toBe(`a`)
    expect(out.tool_calls[0].type).toBe(`function`)
    expect(out.tool_calls[0].function.name).toBe(`f`)
    expect(JSON.parse(out.tool_calls[0].function.arguments).x).toBe(1)
  })

  it(`maps a tool_result block to a role:tool message`, () => {
    const m: ChatMessage = {
      role: `user`,
      content: [{ type: `tool_result`, tool_use_id: `a`, content: `{"ok":1}` }],
      timestamp: 0,
    }
    expect(to_openai_message(m)).toEqual({ role: `tool`, tool_call_id: `a`, content: `{"ok":1}` })
  })

  it(`joins text blocks into a single content string`, () => {
    const m: ChatMessage = {
      role: `assistant`,
      content: [{ type: `text`, text: `foo` }, { type: `text`, text: `bar` }],
      timestamp: 0,
    }
    expect(to_openai_message(m)).toEqual({ role: `assistant`, content: `foobar` })
  })
})
