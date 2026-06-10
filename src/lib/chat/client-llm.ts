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
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content as string
      }
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
      yield {
        type: `tool_calls`,
        calls,
        reasoning_content: reasoning || undefined,
      }
    } catch (err) {
      yield {
        type: `error`,
        message: err instanceof Error ? `Bad tool args: ${err.message}` : `Bad tool args`,
      }
    }
  }
  yield { type: `done` }
}

/** No bytes for this long ⇒ treat the connection as dead and abort. Reset on
 *  every chunk, so a stream that keeps flowing is never cut off. In buffered
 *  (non-streaming) mode — the iOS path, where the whole body arrives at once
 *  only after generation finishes — this acts as a response timeout, sized to
 *  comfortably exceed a text-only reply. */
const IDLE_TIMEOUT_MS = 60_000

/** Wrap a reader so each resolved `read()` fires `on_chunk` — used to re-arm the
 *  idle-timeout watchdog on every byte of activity. All other members
 *  (releaseLock / cancel / closed) are forwarded untouched. */
function with_idle_reset(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  on_chunk: () => void,
): ReadableStreamDefaultReader<Uint8Array> {
  return new Proxy(reader, {
    get(target, prop, recv) {
      if (prop === `read`) {
        return async () => {
          const r = await target.read()
          on_chunk()
          return r
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === `function` ? v.bind(target) : v
    },
  })
}

/** Transient HTTP statuses worth retrying — overload / rate-limit / gateway. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])
/** Total attempts (initial + retries) for the connect/status phase only. Once a
 *  200 body starts streaming we never retry — partial text may already be out. */
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 4000
/** Honor a server `Retry-After` only up to this — beyond it, fail fast rather
 *  than silently stalling the chat (free-tier 429s can ask for ~50s). */
const RETRY_AFTER_CAP_MS = 8000

/** Exponential backoff (no jitter — single client, keeps it deterministic). */
function backoff_ms(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms, else null. */
function retry_after_ms(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/** A sleep that rejects (AbortError) if the signal aborts — so user Stop or the
 *  idle timeout interrupts a backoff wait instead of dragging it out. */
function abortable_sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new DOMException(`Aborted`, `AbortError`))
    }
    const t = setTimeout(resolve, ms)
    signal.addEventListener(`abort`, () => {
      clearTimeout(t)
      reject(new DOMException(`Aborted`, `AbortError`))
    }, { once: true })
  })
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
  // Key-bearing path: hit the provider endpoint via llm_fetch — native Tauri
  // HTTP on mobile (no CORS, no relay fallback), plain fetch in the browser.
  // llm_fetch itself rewrites the few CORS-blocked hosts the CatGo-owned relay
  // is allowed to carry credentials for (NVIDIA) to the relay; everything else
  // goes DIRECT so keys never transit the relay (security §8 C).
  const endpoint = `${base}/chat/completions`
  // INVARIANT: tools must be sent on EVERY turn when non-empty. The
  // chat-completions API is stateless — omitting `tools` on a follow-up turn
  // makes providers (e.g. DeepSeek) stop emitting structured tool_calls and leak
  // raw tool-call markup into content. (Verified against the live DeepSeek API,
  // 2026-05-26.) BUT: an empty `"tools": []` 400s on Anthropic, so OMIT the
  // field entirely when the tool list is empty (defensive — all current
  // callers pass the full CLIENT_TOOLS list).
  const openai_tools = tools.map((t) => ({
    type: `function`,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
  const body = {
    model: config.model,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    ...(openai_tools.length > 0 ? { tools: openai_tools } : {}),
    messages: [
      { role: `system`, content: system },
      ...messages.map(to_openai_message),
    ],
  }
  const headers: Record<string, string> = {
    'Content-Type': `application/json`,
  }
  // Omit the auth header when there's no key (e.g. a keyless local ollama) so we
  // don't send an empty `Bearer ` that some OpenAI-compat servers reject (§8 H).
  if (config.api_key) headers[`Authorization`] = `Bearer ${config.api_key}`
  // Anthropic's OpenAI-compat /v1 endpoint requires the API-version header.
  // anthropic-dangerous-direct-browser-access is intentionally NOT sent — the
  // native-fetch path has no browser CORS, and adding it would only matter on a
  // relayed/browser path that is forbidden for key-bearing requests (§8 C/M).
  if (config.provider === `anthropic`) {
    headers[`anthropic-version`] = `2023-06-01`
  }
  // Idle-timeout watchdog: if no response or bytes arrive for IDLE_TIMEOUT_MS,
  // abort so a stalled connection (dropped Wi-Fi, dead socket) fails cleanly
  // with a retryable error instead of hanging the chat forever — the awaited
  // stream would otherwise never settle, leaving `loading` stuck `true` and
  // silently queueing every later message. Fold the caller's Stop/unmount
  // signal into the same controller; re-arm on every chunk (see with_idle_reset)
  // so a live stream is never cut off.
  const ac = new AbortController()
  let timed_out = false
  let idle_timer: ReturnType<typeof setTimeout> | null = null
  const arm_idle = () => {
    if (idle_timer) clearTimeout(idle_timer)
    idle_timer = setTimeout(() => {
      timed_out = true
      ac.abort()
    }, IDLE_TIMEOUT_MS)
  }
  const clear_idle = () => {
    if (idle_timer) clearTimeout(idle_timer)
    idle_timer = null
  }
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener(`abort`, () => ac.abort(), { once: true })
  }
  const timeout_msg = `The model stopped responding (timed out after ` +
    `${IDLE_TIMEOUT_MS / 1000}s). Check your connection and try again.`

  // Connect/status phase with auto-retry: transient overload / rate-limit /
  // gateway errors (429/503/529/5xx) and bare network failures retry a few
  // times with exponential backoff before surfacing — so a flaky connection or
  // a busy free-tier model self-heals instead of bothering the user. Each
  // attempt is bounded by the idle watchdog; an idle-timeout or user Stop aborts
  // `ac` and is NEVER retried. Retrying is safe: the request is idempotent and
  // no body has been consumed/streamed yet.
  const body_json = JSON.stringify(body)
  let resp: Response | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    arm_idle()
    let r: Response
    try {
      r = await llm_fetch(endpoint, {
        method: `POST`,
        headers,
        body: body_json,
        signal: ac.signal,
      })
    } catch (err) {
      clear_idle()
      if (timed_out) {
        yield { type: `error`, message: timeout_msg }
        return
      }
      if (ac.signal.aborted) {
        yield {
          type: `error`,
          message: err instanceof Error ? err.message : `Aborted`,
        }
        return
      }
      // Network-level failure (DNS, reset, TLS): retry with backoff if attempts
      // remain, otherwise surface.
      if (attempt < MAX_ATTEMPTS) {
        try {
          await abortable_sleep(backoff_ms(attempt), ac.signal)
        } catch {
          yield { type: `error`, message: timed_out ? timeout_msg : `Aborted` }
          return
        }
        continue
      }
      yield {
        type: `error`,
        message: err instanceof Error ? err.message : `Network error`,
      }
      return
    }

    if (r.ok && r.body) {
      resp = r
      break
    }

    // Non-OK: drain the body for the error message, then decide retry vs surface.
    clear_idle()
    const status = r.status
    const detail = await r.text().catch(() => ``)
    const ra = retry_after_ms(r.headers.get(`retry-after`))
    const retryable = RETRYABLE_STATUS.has(status) &&
      attempt < MAX_ATTEMPTS &&
      (ra == null || ra <= RETRY_AFTER_CAP_MS)
    if (retryable) {
      try {
        await abortable_sleep(ra ?? backoff_ms(attempt), ac.signal)
      } catch {
        yield { type: `error`, message: timed_out ? timeout_msg : `Aborted` }
        return
      }
      continue
    }
    yield {
      type: `error`,
      message: `Provider error ${status}: ${redact(detail)}`,
    }
    return
  }
  if (!resp || !resp.body) {
    clear_idle()
    yield {
      type: `error`,
      message: `Provider unavailable after ${MAX_ATTEMPTS} attempts.`,
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
  // The reader is wrapped so every read() re-arms the idle watchdog.
  const reader = with_idle_reset(resp.body.getReader(), arm_idle)
  try {
    const first = await reader.read()
    if (first.done || !looks_like_sse(first.value)) {
      // Buffered (non-streaming): drain whatever remains so a chunked-but-
      // non-streaming body is reassembled in full before JSON-parsing.
      const buf = await drain_reader(first.value, first.done ? null : reader)
      clear_idle()
      yield* parse_openai_stream(buffered_completion_reader(buf))
      return
    }
    yield* parse_openai_stream(prepend_reader(first.value, reader))
  } catch (err) {
    // A mid-stream idle-timeout (or user Stop) aborts the read, surfacing here.
    yield {
      type: `error`,
      message: timed_out
        ? timeout_msg
        : (err instanceof Error ? err.message : `Stream error`),
    }
  } finally {
    // Always cancel the watchdog — including when the consumer stops iterating
    // early (run_tool_loop break / generator .return()), so no timer dangles.
    clear_idle()
  }
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
    if (message.reasoning_content) {
      delta.reasoning_content = message.reasoning_content
    }
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
  if (typeof m.content === `string`) {
    return { role: m.role, content: m.content }
  }

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
