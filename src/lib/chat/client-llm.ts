import type { ChatConfig, ChatMessage, ClientTool, ToolCall } from './types'
import { needs_relay, relay_url } from './provider-routing'

export type LlmEvent =
  | { type: `text`; text: string }
  | { type: `tool_calls`; calls: ToolCall[] }
  | { type: `done` }
  | { type: `error`; message: string }

interface AccTool { id: string; name: string; args: string }

/** Minimal shape of an OpenAI tool_call delta within an SSE chunk. */
interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** Parse an OpenAI-compatible SSE chat stream into typed events. */
export async function* parse_openai_stream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<LlmEvent> {
  const decoder = new TextDecoder()
  let buffer = ``
  const acc = new Map<number, AccTool>()
  let saw_tool_calls = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(`\n`)
    buffer = lines.pop() ?? ``
    for (const line of lines) {
      if (!line.startsWith(`data: `)) continue
      const payload = line.slice(6).trim()
      if (payload === `[DONE]`) break
      let data
      try {
        data = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = data.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) yield { type: `text`, text: delta.content as string }
      if (delta?.tool_calls) {
        saw_tool_calls = true
        for (const tc of delta.tool_calls as ToolCallDelta[]) {
          const idx = tc.index ?? 0
          const cur = acc.get(idx) ?? { id: ``, name: ``, args: `` }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          acc.set(idx, cur)
        }
      }
    }
  }

  if (saw_tool_calls) {
    try {
      const calls: ToolCall[] = [...acc.values()].map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.args ? JSON.parse(t.args) : {},
      }))
      yield { type: `tool_calls`, calls }
    } catch (err) {
      yield { type: `error`, message: err instanceof Error ? `Bad tool args: ${err.message}` : `Bad tool args` }
    }
  }
  yield { type: `done` }
}

/** Send one chat turn to an OpenAI-compatible provider, streaming events. */
export async function* stream_client_llm(
  messages: ChatMessage[],
  config: ChatConfig,
  system: string,
  tools: ClientTool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmEvent> {
  const endpoint = `${config.base_url.replace(/\/$/, ``)}/chat/completions`
  const url = needs_relay(endpoint) ? relay_url(endpoint) : endpoint
  const openai_tools = tools.map((t) => ({
    type: `function`,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const body = {
    model: config.model,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    tools: openai_tools,
    messages: [{ role: `system`, content: system }, ...messages.map(to_openai_message)],
  }
  let resp: Response
  try {
    resp = await fetch(url, {
      method: `POST`,
      headers: { 'Content-Type': `application/json`, Authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    yield { type: `error`, message: err instanceof Error ? err.message : `Network error` }
    return
  }
  if (!resp.ok || !resp.body) {
    yield { type: `error`, message: `Provider error ${resp.status}: ${await resp.text().catch(() => ``)}` }
    return
  }
  yield* parse_openai_stream(resp.body.getReader())
}

/** Convert in-app ChatMessage to OpenAI wire format.
 *  Text-only for now; tool_use/tool_result block mapping is added in Task 8. */
export function to_openai_message(m: ChatMessage): Record<string, unknown> {
  if (typeof m.content === `string`) return { role: m.role, content: m.content }
  const text = m.content
    .filter((b) => b.type === `text`)
    .map((b) => (b as { text: string }).text)
    .join(``)
  return { role: m.role, content: text }
}
