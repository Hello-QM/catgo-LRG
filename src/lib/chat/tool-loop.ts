import type { LlmEvent } from './client-llm'
import type { ToolCall, ToolKind } from './types'

export type LoopEvent =
  | { type: `text`; text: string }
  | { type: `tool_start`; id: string; name: string; input: Record<string, unknown> }
  | { type: `tool_end`; id: string; name: string; result: string; isError: boolean }
  | { type: `permission_request`; id: string; name: string; input: Record<string, unknown> }
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

/** Run the agentic loop until the model returns no tool calls (or the cap is hit). */
export async function run_tool_loop(deps: ToolLoopDeps): Promise<void> {
  const max = deps.max_iterations ?? 25
  for (let i = 0; i < max; i++) {
    if (deps.signal?.aborted) { deps.on_event({ type: `done` }); return }
    let calls: ToolCall[] = []
    for await (const ev of deps.transport()) {
      if (ev.type === `text`) deps.on_event({ type: `text`, text: ev.text })
      else if (ev.type === `tool_calls`) calls = ev.calls
      else if (ev.type === `error`) { deps.on_event({ type: `error`, message: ev.message }); return }
    }
    if (calls.length === 0) { deps.on_event({ type: `done` }); return }

    for (const call of calls) {
      const kind = deps.kind_of(call.name) ?? `mutate` // unknown → treat as mutate (safe)
      if (kind === `mutate`) {
        deps.on_event({ type: `permission_request`, id: call.id, name: call.name, input: call.arguments })
        const allowed = await deps.request_permission(call)
        if (!allowed) {
          deps.on_event({ type: `tool_end`, id: call.id, name: call.name, result: `{"skipped":"denied by user"}`, isError: false })
          continue
        }
      }
      deps.on_event({ type: `tool_start`, id: call.id, name: call.name, input: call.arguments })
      const result = await deps.execute(call.name, call.arguments)
      const isError = result.includes(`"error"`)
      deps.on_event({ type: `tool_end`, id: call.id, name: call.name, result, isError })
    }
  }
  deps.on_event({ type: `done` })
}
