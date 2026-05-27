import { describe, it, expect, vi } from 'vitest'
import { parse_openai_stream, stream_client_llm, to_openai_message, type LlmEvent } from '../client-llm'
import type { ChatConfig, ChatMessage, ClientTool } from '../types'

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

  it(`captures reasoning_content (DeepSeek thinking) on the tool_calls event`, async () => {
    const events: LlmEvent[] = []
    for await (const e of parse_openai_stream(sse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: `Let me ` } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: `think.` } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c1`, function: { name: `fetch_optimade`, arguments: `{"q":"x"}` } }] } }] }),
      JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
    ]))) events.push(e)
    const tc = events.find((e): e is Extract<LlmEvent, { type: `tool_calls` }> => e.type === `tool_calls`)
    expect(tc?.reasoning_content).toBe(`Let me think.`)
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

  it(`echoes reasoning_content on the assistant tool_calls message (DeepSeek thinking)`, () => {
    const m: ChatMessage = {
      role: `assistant`,
      content: [{ type: `tool_use`, id: `a`, name: `f`, input: { x: 1 }, reasoning_content: `think` }],
      timestamp: 0,
    }
    const out = to_openai_message(m) as {
      role: string
      reasoning_content?: string
      tool_calls: { id: string }[]
    }
    expect(out.reasoning_content).toBe(`think`)
    expect(Array.isArray(out.tool_calls)).toBe(true)
    expect(out.tool_calls[0].id).toBe(`a`)
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

describe(`stream_client_llm request body`, () => {
  it(`always includes the tools array in the request`, async () => {
    let captured_body: Record<string, unknown> = {}
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (_url, init) => {
      captured_body = JSON.parse((init as RequestInit).body as string)
      // minimal valid SSE stream so the generator completes
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: [DONE]\n\n`))
          c.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    const config: ChatConfig = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-test`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    }
    const tools: ClientTool[] = [
      { name: `make_supercell`, description: `d`, kind: `mutate`, input_schema: { type: `object`, properties: {} } },
    ]
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm([{ role: `user`, content: `hi`, timestamp: 0 }], config, `sys`, tools, undefined)
    ) events.push(e)
    const captured_tools = captured_body.tools as { type: string; function: { name: string } }[]
    expect(Array.isArray(captured_tools)).toBe(true)
    expect(captured_tools.length).toBeGreaterThan(0)
    expect(captured_tools[0].type).toBe(`function`)
    expect(captured_tools[0].function.name).toBe(`make_supercell`)
    spy.mockRestore()
  })

  it(`falls back to the provider base URL when config.base_url is empty (client-direct)`, async () => {
    let called_url: string | undefined
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (url) => {
      called_url = String(url)
      const enc = new TextEncoder()
      const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: [DONE]\n\n`)); c.close() } })
      return new Response(stream, { status: 200 })
    })
    const config = { provider: `deepseek`, model: `deepseek-chat`, temperature: 0.2, max_tokens: 1024, api_key: `sk-x`, base_url: ``, api_format: `openai`, fetched_models: {}, mode: `universal` } as never
    const events = []
    for await (const e of stream_client_llm([{ role: `user`, content: `hi`, timestamp: 0 }] as never, config, `sys`, [] as never, undefined)) events.push(e)
    expect(called_url).toBe(`https://api.deepseek.com/chat/completions`)
    spy.mockRestore()
  })

  it(`yields an error event (and does not fetch) when both base_url and provider map are empty`, async () => {
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      throw new Error(`fetch should not be called`)
    })
    const config = { provider: `custom`, model: `m`, temperature: 0.2, max_tokens: 1024, api_key: `sk-x`, base_url: ``, api_format: `openai`, fetched_models: {}, mode: `universal` } as never
    const events: LlmEvent[] = []
    for await (const e of stream_client_llm([{ role: `user`, content: `hi`, timestamp: 0 }] as never, config, `sys`, [] as never, undefined)) events.push(e)
    expect(spy).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === `error`)).toBe(true)
    spy.mockRestore()
  })
})
