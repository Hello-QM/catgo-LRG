import { describe, expect, it, vi } from 'vitest'
import {
  type LlmEvent,
  parse_openai_stream,
  stream_client_llm,
  to_openai_message,
} from '../client-llm'
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
    for await (
      const e of parse_openai_stream(sse([
        JSON.stringify({ choices: [{ delta: { content: `Hell` } }] }),
        JSON.stringify({ choices: [{ delta: { content: `o` } }] }),
      ]))
    ) events.push(e)
    const text = events
      .filter((e): e is Extract<LlmEvent, { type: `text` }> => e.type === `text`)
      .map((e) => e.text)
      .join(``)
    expect(text).toBe(`Hello`)
  })

  it(`assembles tool_calls split across chunks`, async () => {
    const events: LlmEvent[] = []
    for await (
      const e of parse_openai_stream(sse([
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `c1`,
                function: { name: `make_supercell`, arguments: `{"nx":2,` },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: `"ny":1,"nz":1}` },
              }],
            },
          }],
        }),
        JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
      ]))
    ) events.push(e)
    const tc = events.find((
      e,
    ): e is Extract<LlmEvent, { type: `tool_calls` }> => e.type === `tool_calls`)
    expect(tc?.calls[0]).toEqual({
      id: `c1`,
      name: `make_supercell`,
      arguments: { nx: 2, ny: 1, nz: 1 },
    })
  })

  it(`captures reasoning_content (DeepSeek thinking) on the tool_calls event`, async () => {
    const events: LlmEvent[] = []
    for await (
      const e of parse_openai_stream(sse([
        JSON.stringify({
          choices: [{ delta: { reasoning_content: `Let me ` } }],
        }),
        JSON.stringify({
          choices: [{ delta: { reasoning_content: `think.` } }],
        }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `c1`,
                function: { name: `fetch_optimade`, arguments: `{"q":"x"}` },
              }],
            },
          }],
        }),
        JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
      ]))
    ) events.push(e)
    const tc = events.find((
      e,
    ): e is Extract<LlmEvent, { type: `tool_calls` }> => e.type === `tool_calls`)
    expect(tc?.reasoning_content).toBe(`Let me think.`)
  })

  it(`yields an error event (not a throw) on malformed tool-call args`, async () => {
    const events: LlmEvent[] = []
    await expect((async () => {
      for await (
        const e of parse_openai_stream(sse([
          JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `c1`,
                  function: { name: `x`, arguments: `{"nx":` },
                }],
              },
            }],
          }),
          JSON.stringify({ choices: [{ finish_reason: `tool_calls` }] }),
        ]))
      ) events.push(e)
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
      tool_calls: {
        id: string
        type: string
        function: { name: string; arguments: string }
      }[]
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
      content: [{
        type: `tool_use`,
        id: `a`,
        name: `f`,
        input: { x: 1 },
        reasoning_content: `think`,
      }],
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
    expect(to_openai_message(m)).toEqual({
      role: `tool`,
      tool_call_id: `a`,
      content: `{"ok":1}`,
    })
  })

  it(`joins text blocks into a single content string`, () => {
    const m: ChatMessage = {
      role: `assistant`,
      content: [{ type: `text`, text: `foo` }, { type: `text`, text: `bar` }],
      timestamp: 0,
    }
    expect(to_openai_message(m)).toEqual({
      role: `assistant`,
      content: `foobar`,
    })
  })
})

describe(`stream_client_llm request body`, () => {
  it(`includes the tools array when the tool list is non-empty`, async () => {
    let captured_body: Record<string, unknown> = {}
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(
      async (_url, init) => {
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
      },
    )
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
      {
        name: `make_supercell`,
        description: `d`,
        kind: `mutate`,
        input_schema: { type: `object`, properties: {} },
      },
    ]
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }],
        config,
        `sys`,
        tools,
        undefined,
      )
    ) events.push(e)
    const captured_tools = captured_body.tools as {
      type: string
      function: { name: string }
    }[]
    expect(Array.isArray(captured_tools)).toBe(true)
    expect(captured_tools.length).toBeGreaterThan(0)
    expect(captured_tools[0].type).toBe(`function`)
    expect(captured_tools[0].function.name).toBe(`make_supercell`)
    spy.mockRestore()
  })

  it(`OMITS the tools field entirely when the tool list is empty (Anthropic 400s on [])`, async () => {
    let captured_body: Record<string, unknown> = {}
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(
      async (_url, init) => {
        captured_body = JSON.parse((init as RequestInit).body as string)
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: [DONE]\n\n`))
            c.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    )
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    expect(`tools` in captured_body).toBe(false)
    spy.mockRestore()
  })

  it(`sends anthropic-version for the anthropic provider`, async () => {
    let captured_headers: Record<string, string> = {}
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(
      async (_url, init) => {
        captured_headers = (init as RequestInit).headers as Record<
          string,
          string
        >
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: [DONE]\n\n`))
            c.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    )
    const config = {
      provider: `anthropic`,
      model: `claude-3-5-sonnet`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-ant-x`,
      base_url: ``,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    expect(captured_headers[`anthropic-version`]).toBe(`2023-06-01`)
    expect(`anthropic-dangerous-direct-browser-access` in captured_headers)
      .toBe(false)
    spy.mockRestore()
  })

  it(`single-read: parses a buffered non-streaming completion via parse_openai_stream`, async () => {
    // Simulate the Tauri HTTP plugin buffering the whole body (no streaming):
    // a single non-streaming OpenAI chat completion delivered in ONE chunk.
    const completion = JSON.stringify({
      choices: [{
        message: { role: `assistant`, content: `Hello from buffered reply` },
      }],
    })
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(completion))
          c.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    const text = events
      .filter((e): e is Extract<LlmEvent, { type: `text` }> => e.type === `text`)
      .map((e) => e.text)
      .join(``)
    expect(text).toBe(`Hello from buffered reply`)
    expect(events.some((e) => e.type === `done`)).toBe(true)
    spy.mockRestore()
  })

  it(`falls back to the provider base URL when config.base_url is empty (client-direct)`, async () => {
    let called_url: string | undefined
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(
      async (url) => {
        called_url = String(url)
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: [DONE]\n\n`))
            c.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    )
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: ``,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    expect(called_url).toBe(`https://api.deepseek.com/chat/completions`)
    spy.mockRestore()
  })

  it(`idle-timeout: a request that never responds aborts with a clean, retryable error`, async () => {
    vi.useFakeTimers()
    // fetch that never resolves on its own — it only rejects once its signal
    // aborts (mirrors a stalled connection the idle watchdog must kill).
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        const sig = (init as RequestInit).signal as AbortSignal | undefined
        sig?.addEventListener(
          `abort`,
          () =>
            reject(
              new DOMException(`The operation was aborted.`, `AbortError`),
            ),
        )
      })
    )
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const gen = stream_client_llm(
      [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
      config,
      `sys`,
      [] as never,
      undefined,
    )
    const first = gen.next() // arms the watchdog, then awaits the (hanging) fetch
    await vi.advanceTimersByTimeAsync(60_000) // trip the idle timeout → abort
    const { value, done } = await first
    expect(done).toBe(false)
    expect((value as LlmEvent).type).toBe(`error`)
    expect((value as Extract<LlmEvent, { type: `error` }>).message).toMatch(
      /timed out/i,
    )
    vi.useRealTimers()
    spy.mockRestore()
  })

  it(`auto-retries transient 503s with backoff, then succeeds`, async () => {
    vi.useFakeTimers()
    const enc = new TextEncoder()
    let calls = 0
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      calls++
      if (calls < 3) {
        return new Response(`{"error":{"code":503}}`, { status: 503 })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: `hi` } }] })}\n\n` +
                `data: [DONE]\n\n`,
            ),
          )
          c.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const collected: LlmEvent[] = []
    const pump = (async () => {
      for await (
        const e of stream_client_llm(
          [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
          config,
          `sys`,
          [] as never,
          undefined,
        )
      ) collected.push(e)
    })()
    // Advance past the two backoff waits (500ms + 1000ms) so both retries fire.
    await vi.advanceTimersByTimeAsync(3000)
    await pump
    expect(calls).toBe(3) // two 503s + one success
    const text = collected
      .filter((e): e is Extract<LlmEvent, { type: `text` }> => e.type === `text`)
      .map((e) => e.text)
      .join(``)
    expect(text).toBe(`hi`)
    expect(collected.some((e) => e.type === `error`)).toBe(false)
    vi.useRealTimers()
    spy.mockRestore()
  })

  it(`does NOT retry a non-transient 4xx (surfaces immediately)`, async () => {
    let calls = 0
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      calls++
      return new Response(`{"error":"bad request"}`, { status: 400 })
    })
    const config = {
      provider: `deepseek`,
      model: `deepseek-chat`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: `https://api.deepseek.com`,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    expect(calls).toBe(1) // 400 is not retryable
    expect(events.some((e) => e.type === `error`)).toBe(true)
    spy.mockRestore()
  })

  it(`yields an error event (and does not fetch) when both base_url and provider map are empty`, async () => {
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      throw new Error(`fetch should not be called`)
    })
    const config = {
      provider: `custom`,
      model: `m`,
      temperature: 0.2,
      max_tokens: 1024,
      api_key: `sk-x`,
      base_url: ``,
      api_format: `openai`,
      fetched_models: {},
      mode: `universal`,
    } as never
    const events: LlmEvent[] = []
    for await (
      const e of stream_client_llm(
        [{ role: `user`, content: `hi`, timestamp: 0 }] as never,
        config,
        `sys`,
        [] as never,
        undefined,
      )
    ) events.push(e)
    expect(spy).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === `error`)).toBe(true)
    spy.mockRestore()
  })
})
