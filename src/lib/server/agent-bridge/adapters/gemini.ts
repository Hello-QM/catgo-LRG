import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, SessionInfo, StreamParams } from '../types.js'

// ---------------------------------------------------------------------------
// Helper: translate a single SDK event to zero or more AgentEvents
// ---------------------------------------------------------------------------

function* translateEvent(event: any): Generator<AgentEvent> {
  const type: string = event?.type

  // ── text / message ─────────────────────────────────────────────────────────
  if (type === 'text' || type === 'message') {
    const text: string = event.text ?? event.content ?? ''
    if (text) {
      yield { type: 'text', text }
    }
    return
  }

  // ── tool_use ───────────────────────────────────────────────────────────────
  if (type === 'tool_use') {
    yield {
      type: 'tool_start',
      toolId: (event.id ?? event.tool_use_id ?? '') as string,
      toolName: (event.name ?? event.tool_name ?? '') as string,
      input: event.input ?? event.params ?? {},
    }
    return
  }

  // ── tool_result ────────────────────────────────────────────────────────────
  if (type === 'tool_result') {
    const resultContent = event.content ?? event.output ?? event.result ?? ''
    const resultText =
      typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent)
    yield {
      type: 'tool_end',
      toolId: (event.tool_use_id ?? event.id ?? '') as string,
      toolName: (event.tool_name ?? event.name ?? '') as string,
      result: resultText,
      isError: !!(event.is_error ?? event.error),
    }
    return
  }

  // ── result / done ──────────────────────────────────────────────────────────
  if (type === 'result') {
    const usage = event.usage
    yield {
      type: 'result',
      isError: !!(event.is_error ?? event.error),
      errorMessage: event.error_message ?? event.message ?? undefined,
      costUsd: event.cost_usd ?? event.total_cost_usd ?? undefined,
      durationMs: event.duration_ms ?? undefined,
      usage: usage
        ? {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cost_usd: event.cost_usd ?? event.total_cost_usd,
          }
        : undefined,
    }
    yield {
      type: 'status',
      sessionId: event.session_id as string | undefined,
      model: event.model as string | undefined,
    }
    return
  }

  if (type === 'done') {
    // done is emitted by the adapter loop itself after the stream ends
    return
  }

  // All other event types are silently ignored.
}

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

export function createGeminiAdapter(): AgentAdapter {
  return {
    agent: 'gemini',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const {
        prompt,
        sessionId,
        model,
        cwd,
        permissionCallback,
        abortSignal,
      } = params

      // Dynamic import so the package is optional at runtime.
      const sdk = await import('@ketd/gemini-cli-sdk' as any) as any

      const effectiveController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => effectiveController.abort(abortSignal.reason))
      }

      const onPermissionRequest = async (request: any): Promise<{ approved: boolean; reason?: string }> => {
        const result = await permissionCallback({
          id: request.id ?? request.tool_use_id ?? '',
          toolName: request.toolName ?? request.tool_name ?? request.name ?? '',
          input: request.input ?? request.params ?? {},
          suggestions: request.suggestions,
          decisionReason: request.decisionReason ?? request.decision_reason,
        })

        return {
          approved: result.behavior === 'allow',
          reason: result.message,
        }
      }

      const client = new sdk.GeminiClient({
        model: model ?? undefined,
        cwd: cwd ?? undefined,
        sessionId: sessionId ?? undefined,
        onPermissionRequest,
      } as any)

      const sdkStream: AsyncIterable<any> = client.stream(prompt, {
        abortController: effectiveController,
      } as any)

      for await (const event of sdkStream) {
        for (const agentEvent of translateEvent(event)) {
          yield agentEvent
        }
      }

      yield { type: 'done' }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // Session listing is not yet supported for the Gemini CLI SDK.
      return []
    },
  }
}

// Self-register at module load time.
registerAdapter('gemini', createGeminiAdapter)
