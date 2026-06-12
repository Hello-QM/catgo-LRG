import type { LlmEvent } from './client-llm'
import type { ToolCall, ToolKind } from './types'

export type LoopEvent =
  | { type: `text`; text: string }
  | {
    type: `tool_start`
    id: string
    name: string
    input: Record<string, unknown>
    reasoning_content?: string
  }
  | {
    type: `tool_end`
    id: string
    name: string
    result: string
    isError: boolean
    reasoning_content?: string
  }
  | {
    type: `permission_request`
    id: string
    name: string
    input: Record<string, unknown>
  }
  | { type: `error`; message: string }
  | { type: `done` }

export interface ToolLoopDeps {
  transport: () => AsyncGenerator<LlmEvent>
  execute: (name: string, input: Record<string, unknown>) => Promise<string>
  kind_of: (name: string) => ToolKind | undefined
  request_permission: (call: ToolCall) => Promise<boolean>
  on_event: (e: LoopEvent) => void
  max_iterations?: number
  signal?: AbortSignal
}

/** A tool result is an error iff it parses to an object with a string `error` field. */
function is_error_result(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result)
    return typeof parsed === `object` && parsed !== null &&
      typeof (parsed as { error?: unknown }).error === `string`
  } catch {
    return false
  }
}

// A content-free completion (no text, no tool_calls, no error) is retried this
// many times before giving up. Some providers — notably DeepSeek on a bare
// first turn (large tooled system prompt + a short user message) — occasionally
// return an empty body; re-issuing the same request usually produces real
// output. Without this the turn silently ends with nothing rendered, so the
// user thinks their message did nothing (and the bonds stay visible until they
// send a second message that happens to nudge the model into responding).
const EMPTY_COMPLETION_ATTEMPTS = 3

/** Run the agentic loop until the model returns no tool calls (or the cap is hit). */
export async function run_tool_loop(deps: ToolLoopDeps): Promise<void> {
  const max = deps.max_iterations ?? 25
  // Signature of the previous turn's tool calls (names + args). Weak local
  // models (e.g. Ollama qwen2.5) often fail to recognize that an action already
  // succeeded and re-issue the SAME call every turn — a runaway loop that burns
  // the iteration cap, pins CPU on repeated inference, and ends in "Aborted".
  // If a turn repeats the prior turn's exact calls, the model is stuck on a
  // done action: stop cleanly instead of looping.
  let prev_calls_sig: string | null = null
  // A small model often runs a tool then stops WITHOUT narrating (or its only
  // "narration" is the duplicate call the loop guard just suppressed). Track
  // whether anything was ever said, plus the human-readable `message` fields of
  // the most recent tool run, so we can synthesize a confirmation rather than
  // leave the user with a bare tool row and no reply.
  let any_text = false
  let last_tool_msgs: string[] = []
  const emit_done = (): void => {
    if (!any_text && last_tool_msgs.length) {
      deps.on_event({ type: `text`, text: last_tool_msgs.join(` `) })
    }
    deps.on_event({ type: `done` })
  }
  for (let i = 0; i < max; i++) {
    if (deps.signal?.aborted) {
      deps.on_event({ type: `done` })
      return
    }
    let calls: ToolCall[] = []
    // DeepSeek thinking models stream chain-of-thought via reasoning_content on
    // the same turn that emits tool_calls. It must be echoed back on the
    // assistant tool-call message in the follow-up request — surface it on the
    // per-call tool_start/tool_end events so chat-state can attach it to the
    // replayed tool_use block. All calls in one turn share the same reasoning.
    let reasoning: string | undefined
    // Only the FIRST turn MUST produce something (text or a tool call). A
    // content-free opening completion is a provider hiccup — retry it. A LATER
    // empty turn (after tools already ran) legitimately means the model is done,
    // so it is not retried. Retrying is safe: an empty turn emitted nothing, so a
    // re-issue can't duplicate partial output.
    const retry_empty = i === 0
    const attempts = retry_empty ? EMPTY_COMPLETION_ATTEMPTS : 1
    let produced = false
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (deps.signal?.aborted) {
        deps.on_event({ type: `done` })
        return
      }
      calls = []
      let got_text = false
      for await (const ev of deps.transport()) {
        if (ev.type === `text`) {
          if (ev.text) {
            got_text = true
            any_text = true
          }
          deps.on_event({ type: `text`, text: ev.text })
        } else if (ev.type === `tool_calls`) {
          calls = ev.calls
          reasoning = ev.reasoning_content
        } else if (ev.type === `error`) {
          deps.on_event({ type: `error`, message: ev.message })
          return
        }
      }
      if (got_text || calls.length > 0) {
        produced = true
        break
      }
    }
    if (!produced) {
      // First turn still empty after retries → surface it (don't silently die).
      // A later empty turn → normal completion (tools already ran).
      if (retry_empty) {
        deps.on_event({
          type: `error`,
          message: `The model returned an empty response — please try again.`,
        })
        return
      }
      emit_done()
      return
    }
    if (calls.length === 0) {
      emit_done()
      return
    }

    // Loop guard: if this turn's calls are identical to the previous turn's, the
    // model is repeating an already-completed action (not making progress).
    // Stop — the tools already ran and their results are shown.
    const calls_sig = JSON.stringify(calls.map((c) => [c.name, c.arguments]))
    if (calls_sig === prev_calls_sig) {
      emit_done()
      return
    }
    prev_calls_sig = calls_sig

    const turn_msgs: string[] = []
    for (const call of calls) {
      const kind = deps.kind_of(call.name) ?? `mutate` // unknown → treat as mutate (safe)
      if (kind === `mutate`) {
        deps.on_event({
          type: `permission_request`,
          id: call.id,
          name: call.name,
          input: call.arguments,
        })
        const allowed = await deps.request_permission(call)
        if (!allowed) {
          deps.on_event({
            type: `tool_end`,
            id: call.id,
            name: call.name,
            result: `{"skipped":"denied by user"}`,
            isError: false,
            reasoning_content: reasoning,
          })
          continue
        }
      }
      deps.on_event({
        type: `tool_start`,
        id: call.id,
        name: call.name,
        input: call.arguments,
        reasoning_content: reasoning,
      })
      const result = await deps.execute(call.name, call.arguments)
      const isError = is_error_result(result)
      if (!isError) {
        const msg = message_of(result)
        if (msg) turn_msgs.push(msg)
      }
      deps.on_event({
        type: `tool_end`,
        id: call.id,
        name: call.name,
        result,
        isError,
        reasoning_content: reasoning,
      })
    }
    // Remember this turn's confirmations; if the model later stops without
    // speaking, emit_done() surfaces them as the reply.
    if (turn_msgs.length) last_tool_msgs = turn_msgs
  }
  emit_done()
}

/** Extract a tool result's human-readable `message` string, if any. */
function message_of(result: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result)
    const m = (parsed as { message?: unknown } | null)?.message
    return typeof m === `string` && m.trim() ? m : null
  } catch {
    return null
  }
}
