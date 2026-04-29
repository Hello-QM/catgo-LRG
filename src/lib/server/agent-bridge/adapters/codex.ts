import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, SessionInfo, StreamParams } from '../types.js'

// ---------------------------------------------------------------------------
// Helper: translate a single Codex SDK event to zero or more AgentEvents
// ---------------------------------------------------------------------------

function* translateEvent(evt: any): Generator<AgentEvent> {
  const type: string = evt?.type ?? ''

  // ── text / message delta ───────────────────────────────────────────────────
  if (type === 'text' || type === 'message') {
    const text: string = evt.text ?? evt.content ?? evt.delta ?? ''
    if (text) yield { type: 'text', text }
    return
  }

  // ── streaming text delta ───────────────────────────────────────────────────
  if (type === 'text_delta' || type === 'output_text_delta') {
    const text: string = evt.text ?? evt.delta ?? ''
    if (text) yield { type: 'text', text }
    return
  }

  // ── tool use / function call ───────────────────────────────────────────────
  if (type === 'tool_use' || type === 'function_call') {
    const toolId: string = evt.id ?? evt.tool_use_id ?? evt.call_id ?? ''
    const toolName: string = evt.name ?? evt.function?.name ?? ''
    const input: unknown = evt.input ?? evt.arguments ?? {}
    yield { type: 'tool_start', toolId, toolName, input }
    return
  }

  // ── tool result / function result ─────────────────────────────────────────
  if (type === 'tool_result' || type === 'function_result' || type === 'tool_call_output') {
    const toolId: string = evt.tool_use_id ?? evt.call_id ?? evt.id ?? ''
    const toolName: string = evt.name ?? ''
    const output: any = evt.output ?? evt.content ?? evt.result ?? ''
    const isError = !!(evt.is_error ?? evt.error)
    const resultText: string =
      typeof output === 'string' ? output : JSON.stringify(output)
    yield { type: 'tool_end', toolId, toolName, result: resultText, isError }
    return
  }

  // ── approval / permission request ─────────────────────────────────────────
  if (type === 'approval_request' || type === 'permission_request') {
    const id: string = evt.id ?? evt.request_id ?? ''
    const toolName: string = evt.command ?? evt.tool_name ?? evt.name ?? ''
    const input: Record<string, unknown> = evt.input ?? evt.params ?? {}
    yield { type: 'permission_request', id, toolName, input }
    return
  }

  // ── result / done ──────────────────────────────────────────────────────────
  if (type === 'result' || type === 'done' || type === 'finished') {
    const isError = !!(evt.is_error ?? evt.error)
    const errorMessage: string | undefined =
      typeof evt.error === 'string' ? evt.error : (evt.error?.message ?? undefined)
    yield {
      type: 'result',
      isError,
      errorMessage,
      durationMs: evt.duration_ms ?? undefined,
    }
    yield { type: 'done' }
    return
  }

  // All other event types are silently ignored.
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export function createCodexAdapter(): AgentAdapter {
  return {
    agent: 'codex',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const { prompt, sessionId, model, cwd, abortSignal } = params

      // Dynamic import — the package may not be installed everywhere.
      const { Codex } = (await import('@openai/codex-sdk')) as any

      const codex = new Codex({ model: model ?? undefined }) as any

      const thread = sessionId
        ? (codex.resumeThread(sessionId) as any)
        : (codex.startThread() as any)

      const abortController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () =>
          abortController.abort(abortSignal.reason),
        )
      }

      const streamIterable = thread.runStreamed(prompt, {
        abortController,
        cwd: cwd ?? undefined,
        approvalPolicy: 'on-request',
      }) as AsyncIterable<any>

      let resultEmitted = false

      for await (const evt of streamIterable) {
        for (const agentEvent of translateEvent(evt)) {
          yield agentEvent
          if (agentEvent.type === 'done') resultEmitted = true
        }
      }

      // Ensure we always close the stream with a result + done pair even if
      // the SDK didn't emit a terminal event.
      if (!resultEmitted) {
        yield { type: 'result', isError: false }
        yield { type: 'done' }
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // The Codex SDK does not expose a session listing API at this time.
      return []
    },
  }
}

// Self-register at module load time.
registerAdapter('codex', createCodexAdapter)
