import type {
  ChatConfig,
  ChatMessage,
  ClientTool,
  LLMProvider,
  ToolCall,
  ToolResultBlock,
  ToolUseBlock,
} from './types'
import { llm_fetch, normalize_provider_base_url } from './provider-routing'
import { redact } from './message-utils'

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

interface AccTool {
  id: string
  name: string
  args: string
}

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
      yield {
        type: `error`,
        message: err instanceof Error ? `Bad tool args: ${err.message}` : `Bad tool args`,
      }
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
  const base = normalize_provider_base_url(
    config.base_url || PROVIDER_BASE_URLS[config.provider] || ``,
  )
  if (!base) {
    yield {
      type: `error`,
      message:
        `No base URL configured for provider "${config.provider}". Set a base URL in CatBot settings.`,
    }
    return
  }
  // Key-bearing path: ALWAYS hit the DIRECT provider endpoint. We must not
  // rewrite to the relay (relay_url) here — the request carries the user's API
  // key and the relay is a third party (security §8 C). llm_fetch uses the
  // native Tauri HTTP plugin on mobile (no CORS, no relay fallback) and a plain
  // fetch on desktop.
  const endpoint = `${base}/chat/completions`
  // INVARIANT: tools must be sent on EVERY turn when non-empty. The
  // chat-completions API is stateless — omitting `tools` on a follow-up turn
  // makes providers (e.g. DeepSeek) stop emitting structured tool_calls and leak
  // raw tool-call markup into content. (Verified against the live DeepSeek API,
  // 2026-05-26.) BUT: an empty `"tools": []` 400s on Anthropic, so OMIT the
  // field entirely when the tool list is empty (text-only mobile chat path).
  const openai_tools = tools.map((t) => ({
    type: `function`,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const body = {
    model: config.model,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    ...(openai_tools.length > 0 ? { tools: openai_tools } : {}),
    messages: [{ role: `system`, content: system }, ...messages.map(to_openai_message)],
  }
  const headers: Record<string, string> = { 'Content-Type': `application/json` }
  // Omit the auth header when there's no key (e.g. a keyless local ollama) so we
  // don't send an empty `Bearer ` that some OpenAI-compat servers reject (§8 H).
  if (config.api_key) headers[`Authorization`] = `Bearer ${config.api_key}`
  // Anthropic's OpenAI-compat /v1 endpoint requires the API-version header.
  // anthropic-dangerous-direct-browser-access is intentionally NOT sent — the
  // native-fetch path has no browser CORS, and adding it would only matter on a
  // relayed/browser path that is forbidden for key-bearing requests (§8 C/M).
  if (config.provider === `anthropic`) headers[`anthropic-version`] = `2023-06-01`
  let resp: Response
  try {
    resp = await llm_fetch(endpoint, {
      method: `POST`,
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    yield { type: `error`, message: err instanceof Error ? err.message : `Network error` }
    return
  }
  if (!resp.ok || !resp.body) {
    yield {
      type: `error`,
      message: `Provider error ${resp.status}: ${redact(await resp.text().catch(() => ``))}`,
    }
    return
  }

  // Single-read detection (mobile: the Tauri HTTP plugin may buffer the whole
  // body instead of streaming). Do ONE read. A streaming SSE body's first chunk
  // is `data:`-framed; a buffered non-streaming completion arrives as a single
  // JSON object (no `data:` prefix). When the read is `done` (empty/whole body)
  // OR the first chunk is NOT SSE-framed, treat it as a buffered completion:
  // JSON-parse it and replay it through parse_openai_stream as one synthetic
  // SSE chunk (reuse the parser — do NOT fork parsing). Otherwise stream, with
  // the consumed first chunk pushed back in front of the live reader.
  const reader = resp.body.getReader()
  const first = await reader.read()
  if (first.done || !looks_like_sse(first.value)) {
    // Buffered (non-streaming): drain whatever remains so a chunked-but-
    // non-streaming body is reassembled in full before JSON-parsing.
    const buf = await drain_reader(first.value, first.done ? null : reader)
    yield* parse_openai_stream(buffered_completion_reader(buf))
    return
  }
  yield* parse_openai_stream(prepend_reader(first.value, reader))
}

/** Concatenate the first chunk with any remaining reader output into one buffer. */
async function drain_reader(
  first: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = first ? [first] : []
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Heuristic: does the first chunk look like an SSE stream (`data:`-framed)?
 *  A buffered non-streaming completion is a bare JSON object instead. */
function looks_like_sse(value: Uint8Array | undefined): boolean {
  if (!value || value.length === 0) return false
  // A streaming SSE body opens with a `data:` event — or a `:` keep-alive/comment
  // line before the first event (some providers do this). Either means "stream",
  // not a buffered JSON completion.
  const first_line = new TextDecoder().decode(value).trimStart().split(`\n`)[0]
  return first_line.startsWith(`data:`) || first_line.startsWith(`:`)
}

/** Wrap an already-buffered non-streaming completion body as a one-shot SSE
 *  reader so it flows through parse_openai_stream unchanged. Converts the
 *  message.content (+ tool_calls) of a non-streaming response into a single
 *  `data:` delta chunk followed by `[DONE]`. */
function buffered_completion_reader(
  value: Uint8Array,
): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder()
  let sse = `data: [DONE]\n\n`
  try {
    const text = value.length ? new TextDecoder().decode(value) : ``
    const json = JSON.parse(text)
    const message = json?.choices?.[0]?.message ?? {}
    // Reshape message → a streaming-style delta the parser already understands.
    const delta: Record<string, unknown> = {}
    if (message.content) delta.content = message.content
    if (message.reasoning_content) delta.reasoning_content = message.reasoning_content
    if (Array.isArray(message.tool_calls)) {
      delta.tool_calls = message.tool_calls.map((
        tc: Record<string, unknown>,
        i: number,
      ) => ({
        index: i,
        id: tc.id,
        function: tc.function,
      }))
    }
    const chunk = JSON.stringify({ choices: [{ delta }] })
    sse = `data: ${chunk}\n\ndata: [DONE]\n\n`
  } catch {
    // Non-JSON / empty buffer: emit just [DONE] so the parser yields a clean
    // `done` event (an empty assistant reply rather than a thrown parse error).
  }
  return single_chunk_reader(enc.encode(sse))
}

/** A reader that yields one pre-encoded chunk then ends. */
function single_chunk_reader(
  bytes: Uint8Array,
): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  }).getReader()
}

/** Re-prepend an already-consumed first chunk in front of the live reader so
 *  the streaming SSE parser sees the whole body. */
function prepend_reader(
  first: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (first) {
        c.enqueue(first)
        first = undefined
        return
      }
      const { done, value } = await reader.read()
      if (done) {
        c.close()
        return
      }
      if (value) c.enqueue(value)
    },
    cancel(reason) {
      void reader.cancel(reason)
    },
  }).getReader()
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
  const result_block = m.content.find((b): b is ToolResultBlock =>
    b.type === `tool_result`
  )
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
    const reasoning_content = use_blocks.find((b) => b.reasoning_content)
      ?.reasoning_content
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
