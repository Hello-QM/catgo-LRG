// Frontend SSE parser for the unified /api/agent/stream endpoint.
// Yields AgentEvent objects from the SSE stream.
//
// In `pnpm desktop:dev` the endpoint is served by vite-plugin-agent-bridge.ts
// against the dev origin, so a relative URL works. In production AppImage
// builds it is served by the `catgo-agent` sidecar (Bun-compiled Node binary)
// listening on 127.0.0.1:8001 — the Rust setup hook in src-tauri/src/lib.rs
// stashes the live port on `window.__CATGO_AGENT_PORT__` so we can target it
// absolutely from the webview origin (tauri://localhost).

import type { AgentType, Attachment } from './types'

function getAgentBase(): string {
  if (typeof window !== `undefined`) {
    const port = (window as unknown as { __CATGO_AGENT_PORT__?: number | string })
      .__CATGO_AGENT_PORT__
    if (port) return `http://127.0.0.1:${port}`
  }
  return ``
}

export interface AgentEvent {
  type: string
  [key: string]: unknown
}

export interface StreamAgentParams {
  agent: AgentType
  prompt: string
  sessionId?: string
  model?: string
  systemPrompt?: string
  attachments?: Attachment[]
  signal?: AbortSignal
  /**
   * Per-tab identifier forwarded to the SvelteKit route, which passes it to
   * the SDK adapter. The adapter injects it as an `X-CatGo-Tab-Id` HTTP
   * header on MCP requests, so backend MCP tools push structures/workflows
   * back to the specific tab that issued the chat rather than a shared
   * "default" panel. Omit for legacy / popout contexts.
   */
  tabId?: string
  /**
   * When true, forwarded to the server and into the Claude adapter's
   * canUseTool so ALL non-CatGo tools are auto-allowed without a
   * PermissionCard for this stream. Mirrors the chat slice's session-scoped
   * skip_permission flag; never persisted.
   */
  skipPermissions?: boolean
  /**
   * Per-chat-thread key. Forwarded to the Gemini adapter's persistent ACP
   * process pool so repeat prompts in the same chat tab reuse one
   * `gemini --acp` process and keep cross-turn context. The Claude/Codex
   * adapters ignore it (their SDKs persist the subprocess themselves).
   */
  chatId?: string
}

export async function* stream_sdk_agent(
  params: StreamAgentParams,
): AsyncGenerator<AgentEvent> {
  const { agent, prompt, sessionId, model, systemPrompt, attachments, signal, tabId, skipPermissions, chatId } = params

  const response = await fetch(`${getAgentBase()}/api/agent/stream`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ agent, prompt, sessionId, model, systemPrompt, attachments, tabId, skipPermissions, chatId }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => `${response.status}`)
    throw new Error(`Agent stream failed: ${text}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error(`No response body`)

  const decoder = new TextDecoder()
  let buffer = ``

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split(`\n\n`)
      buffer = parts.pop() ?? ``

      for (const part of parts) {
        for (const line of part.split(`\n`)) {
          if (!line.startsWith(`data: `)) continue
          const data = line.slice(6)
          if (data === `[DONE]`) return

          try {
            const event = JSON.parse(data) as AgentEvent
            yield event
            if (event.type === `done`) return
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function resolve_permission(
  permissionId: string,
  behavior: `allow` | `allow_session` | `deny`,
  suggestions?: unknown[],
  updatedInput?: Record<string, unknown>,
): Promise<boolean> {
  const resp = await fetch(`${getAgentBase()}/api/agent/permission`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ permissionId, behavior, suggestions, updatedInput }),
  })
  if (!resp.ok) return false
  const data = await resp.json()
  return data.ok === true
}
