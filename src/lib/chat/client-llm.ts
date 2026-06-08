import type { ChatConfig, ChatMessage, ClientTool, ToolCall, ToolUseBlock, ToolResultBlock, LLMProvider } from './types'
import { needs_relay, normalize_provider_base_url, relay_url } from './provider-routing'

/** Default OpenAI-compatible base URLs for known API providers, mirrored from
 *  the backend (server/catgo/routers/chat.py). Used in client-direct mode where
 *  the backend /chat/providers list (which normally supplies base_url) is absent. */
export const PROVIDER_BASE_URLS: Partial<Record<LLMProvider, string>> = {
  deepseek: `https://api.deepseek.com`,
  qwen: `https://dashscope.aliyuncs.com/compatible-mode/v1`,
  kimi: `https://api.moonshot.cn/v1`,
  zhipu: `https://open.bigmodel.cn/api/paas/v4`,
  gemini: `https://generativelanguage.googleapis.com/v1beta/openai`,
  anthropic: `https://api.anthropic.com/v1`,
}

export type LlmEvent =
  | { type: `text`; text: string }
  | { type: `tool_calls`; calls: ToolCall[]; reasoning_content?: string }
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
  // DeepSeek thinking models stream chain-of-thought via delta.reasoning_content.
  // It must be echoed back on the assistant tool-call message (see to_openai_message).
  let reasoning = ``

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
      if (delta?.reasoning_content) reasoning += delta.reasoning_content as string
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
      yield { type: `tool_calls`, calls, reasoning_content: reasoning || undefined }
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
  const base = normalize_provider_base_url(config.base_url || PROVIDER_BASE_URLS[config.provider] || ``)
  if (!base) {
    yield { type: `error`, message: `No base URL configured for provider "${config.provider}". Set a base URL in CatBot settings.` }
    return
  }
  const endpoint = `${base}/chat/completions`
  const url = needs_relay(endpoint) ? relay_url(endpoint) : endpoint
  // INVARIANT: tools must be sent on EVERY turn. The chat-completions API is
  // stateless — omitting `tools` on a follow-up turn makes providers (e.g. DeepSeek)
  // stop emitting structured tool_calls and leak raw tool-call markup into content.
  // (Verified against the live DeepSeek API, 2026-05-26.)
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
 *
 *  OpenAI function-calling wire shapes:
 *    - assistant tool call → { role:'assistant', content:null,
 *        tool_calls:[{ id, type:'function', function:{ name, arguments:<JSON string> } }] }
 *    - tool result → { role:'tool', tool_call_id, content:<string> }
 *    - plain text → { role, content }
 *
 *  ASSUMPTION: this returns exactly ONE wire object per ChatMessage. Task 8's
 *  client-direct branch constructs history with one block per ChatMessage (one
 *  tool_use block → one assistant message; one tool_result block → one user
 *  message), so handling the FIRST relevant block by priority
 *  (tool_result → tool_use → text) is sufficient and keeps the
 *  assistant-tool_calls / tool-result pairing OpenAI requires. */
export function to_openai_message(m: ChatMessage): Record<string, unknown> {
  if (typeof m.content === `string`) return { role: m.role, content: m.content }

  // tool_result → role:'tool' (highest priority; a single result block per msg).
  const result_block = m.content.find((b): b is ToolResultBlock => b.type === `tool_result`)
  if (result_block) {
    const content = typeof result_block.content === `string`
      ? result_block.content
      : JSON.stringify(result_block.content)
    return { role: `tool`, tool_call_id: result_block.tool_use_id, content }
  }

  // tool_use → assistant message carrying tool_calls.
  const use_blocks = m.content.filter((b): b is ToolUseBlock => b.type === `tool_use`)
  if (use_blocks.length > 0) {
    // DeepSeek thinking models reject the follow-up request unless the assistant
    // message that emitted the tool_calls carries back its reasoning_content.
    const reasoning_content = use_blocks.find((b) => b.reasoning_content)?.reasoning_content
    return {
      role: `assistant`,
      content: null,
      ...(reasoning_content ? { reasoning_content } : {}),
      tool_calls: use_blocks.map((b) => ({
        id: b.id,
        type: `function`,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      })),
    }
  }

  // Otherwise: join text blocks (unchanged behavior).
  const text = m.content
    .filter((b): b is import('./types').TextBlock => b.type === `text`)
    .map((b) => b.text)
    .join(``)
  return { role: m.role, content: text }
}
