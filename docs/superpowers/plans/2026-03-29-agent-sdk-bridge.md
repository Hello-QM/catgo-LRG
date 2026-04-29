# Agent SDK Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace subprocess-based CLI agent integration with official Agent SDKs (Claude, Codex, Gemini), adding interactive permission approval, real-time tool progress, and multimodal input.

**Architecture:** Thin adapter layer in `src/lib/server/agent-bridge/` translates three SDK event streams into a unified `AgentEvent` type. SvelteKit server routes expose SSE streaming and permission resolution. Frontend renders inline PermissionCard and ToolProgressBlock components.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@ketd/gemini-cli-sdk`, SvelteKit server routes, Svelte 5 runes.

**Spec:** `docs/superpowers/specs/2026-03-29-agent-sdk-bridge-design.md`

---

## File Structure

### New files

```
src/lib/server/agent-bridge/
  types.ts              — AgentEvent union, Attachment, TokenUsage, SessionInfo types
  adapter.ts            — AgentAdapter interface, createAdapter() factory
  permission-manager.ts — In-memory pending permission map, register/resolve
  adapters/
    claude.ts           — Claude Agent SDK → AgentEvent translator
    codex.ts            — Codex SDK → AgentEvent translator
    gemini.ts           — Gemini CLI SDK → AgentEvent translator

src/routes/api/agent/
  stream/+server.ts     — POST: unified SSE streaming endpoint
  permission/+server.ts — POST: permission resolve endpoint
  sessions/+server.ts   — GET: list sessions for an agent

src/lib/chat/
  PermissionCard.svelte     — Inline permission approval UI
  ToolProgressBlock.svelte  — Inline tool execution detail view
  sdk-stream.ts             — Frontend SSE parser for AgentEvent
```

### Modified files

```
src/lib/chat/types.ts           — Add sdk-* providers, SDK_PROVIDERS set, Attachment type
src/lib/chat/chat-state.svelte.ts — Add SDK streaming path in send_message(), rename cli_sessions → agent_sessions
src/lib/chat/ChatPane.svelte    — Render PermissionCard/ToolProgressBlock, add attachment UI
src/lib/chat/message-utils.ts   — Add PROVIDER_META entries for sdk-* providers
package.json                    — Add three SDK dependencies
```

---

### Task 1: Install SDK dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the three Agent SDKs**

```bash
pnpm add @anthropic-ai/claude-agent-sdk @openai/codex-sdk @ketd/gemini-cli-sdk
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@anthropic-ai/claude-agent-sdk'); console.log('claude-agent-sdk OK')"
node -e "require('@openai/codex-sdk'); console.log('codex-sdk OK')"
node -e "require('@ketd/gemini-cli-sdk'); console.log('gemini-cli-sdk OK')"
```

Expected: All three print OK.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add Agent SDK dependencies (Claude, Codex, Gemini)"
```

---

### Task 2: Bridge types and adapter interface

**Files:**
- Create: `src/lib/server/agent-bridge/types.ts`
- Create: `src/lib/server/agent-bridge/adapter.ts`

- [ ] **Step 1: Create types.ts**

```typescript
// src/lib/server/agent-bridge/types.ts

export type AgentType = 'claude' | 'codex' | 'gemini'

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cost_usd?: number
}

export interface Attachment {
  type: 'image' | 'pdf' | 'file'
  name: string
  mimeType: string
  data: string // base64
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsedSeconds: number }
  | { type: 'tool_end'; toolId: string; toolName: string; result: string; isError: boolean }
  | { type: 'permission_request'; id: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; decisionReason?: string }
  | { type: 'permission_resolved'; id: string; behavior: 'allow' | 'deny' }
  | { type: 'status'; sessionId?: string; model?: string }
  | { type: 'result'; usage?: TokenUsage; isError: boolean; errorMessage?: string; costUsd?: number; durationMs?: number }
  | { type: 'done' }

export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
}

export interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedPermissions?: unknown[]
  message?: string
}

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
}

export interface StreamParams {
  prompt: string
  sessionId?: string
  model?: string
  cwd?: string
  mcpServerUrl?: string
  attachments?: Attachment[]
  permissionCallback: (req: PermissionRequest) => Promise<PermissionResult>
  abortSignal?: AbortSignal
}
```

- [ ] **Step 2: Create adapter.ts**

```typescript
// src/lib/server/agent-bridge/adapter.ts

import type { AgentType, AgentEvent, StreamParams, SessionInfo } from './types.js'

export interface AgentAdapter {
  readonly agent: AgentType
  stream(params: StreamParams): AsyncGenerator<AgentEvent>
  listSessions(): Promise<SessionInfo[]>
}

const adapters = new Map<AgentType, () => AgentAdapter>()

export function registerAdapter(agent: AgentType, factory: () => AgentAdapter): void {
  adapters.set(agent, factory)
}

export function createAdapter(agent: AgentType): AgentAdapter {
  const factory = adapters.get(agent)
  if (!factory) throw new Error(`Unknown agent: ${agent}`)
  return factory()
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/agent-bridge/types.ts src/lib/server/agent-bridge/adapter.ts
git commit -m "feat(agent-bridge): add unified event types and adapter interface"
```

---

### Task 3: Permission manager

**Files:**
- Create: `src/lib/server/agent-bridge/permission-manager.ts`

- [ ] **Step 1: Create permission-manager.ts**

```typescript
// src/lib/server/agent-bridge/permission-manager.ts

import type { PermissionRequest, PermissionResult } from './types.js'

interface PendingEntry {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
  createdAt: number
}

// In-memory store — keyed by toolUseID (unique per tool call)
const pending = new Map<string, PendingEntry>()

// Auto-cleanup stale entries older than 10 minutes
const STALE_MS = 10 * 60 * 1000

function cleanupStale(): void {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > STALE_MS) {
      entry.resolve({ behavior: 'deny', message: 'Permission request timed out' })
      pending.delete(id)
    }
  }
}

/**
 * Register a pending permission request.
 * Returns a Promise that resolves when the user approves/denies.
 * The SDK stream blocks on this Promise.
 */
export function registerPending(request: PermissionRequest): Promise<PermissionResult> {
  cleanupStale()
  return new Promise<PermissionResult>((resolve) => {
    pending.set(request.id, { request, resolve, createdAt: Date.now() })
  })
}

/**
 * Resolve a pending permission request (called when user clicks Allow/Deny).
 * Returns true if the permission was found and resolved.
 */
export function resolvePending(
  id: string,
  behavior: 'allow' | 'allow_session' | 'deny',
  suggestions?: unknown[],
): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)

  if (behavior === 'deny') {
    entry.resolve({ behavior: 'deny', message: 'Denied by user' })
  } else {
    // 'allow' and 'allow_session' both resolve as allow
    // 'allow_session' passes suggestions as updatedPermissions so the SDK
    // remembers the choice for subsequent calls in this session
    entry.resolve({
      behavior: 'allow',
      updatedPermissions: behavior === 'allow_session' ? (suggestions ?? []) : undefined,
    })
  }
  return true
}

/** Check if a permission request is pending (for status queries). */
export function isPending(id: string): boolean {
  return pending.has(id)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/server/agent-bridge/permission-manager.ts
git commit -m "feat(agent-bridge): add permission manager with register/resolve"
```

---

### Task 4: Claude adapter

**Files:**
- Create: `src/lib/server/agent-bridge/adapters/claude.ts`

- [ ] **Step 1: Create claude.ts**

```typescript
// src/lib/server/agent-bridge/adapters/claude.ts

import { query, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage, PermissionResult as SDKPermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, StreamParams, SessionInfo, PermissionResult } from '../types.js'

function createClaudeAdapter(): AgentAdapter {
  return {
    agent: 'claude',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const {
        prompt, sessionId, model, cwd, mcpServerUrl,
        attachments, permissionCallback, abortSignal,
      } = params

      const abortController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }

      // Build MCP server config if URL provided
      const mcpServers = mcpServerUrl
        ? { catgo: { type: 'http' as const, url: mcpServerUrl } }
        : undefined

      const q = query({
        prompt,
        options: {
          abortController,
          cwd: cwd ?? process.env.HOME,
          model,
          resume: sessionId,
          includePartialMessages: true,
          mcpServers,
          permissionMode: 'default',
          canUseTool: async (toolName, input, options) => {
            const result = await permissionCallback({
              id: options.toolUseID,
              toolName,
              input,
              suggestions: options.suggestions,
              decisionReason: options.decisionReason,
            })
            // Map our PermissionResult to SDK's format
            if (result.behavior === 'deny') {
              return { behavior: 'deny', message: result.message ?? 'Denied by user', toolUseID: options.toolUseID }
            }
            const sdkResult: SDKPermissionResult = {
              behavior: 'allow',
              toolUseID: options.toolUseID,
            }
            if (result.updatedPermissions) {
              sdkResult.updatedPermissions = result.updatedPermissions as any
            }
            return sdkResult
          },
        },
      })

      try {
        for await (const message of q) {
          yield* translateMessage(message)
        }
      } finally {
        yield { type: 'done' }
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      const sessions = await sdkListSessions()
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.customTitle ?? s.summary ?? s.firstPrompt ?? 'Untitled',
        lastModified: s.lastModified,
        cwd: s.cwd,
      }))
    },
  }
}

function* translateMessage(msg: SDKMessage): Generator<AgentEvent> {
  switch (msg.type) {
    case 'assistant': {
      // SDKAssistantMessage — contains a BetaMessage with content blocks
      const betaMsg = msg.message as any
      if (!betaMsg?.content) break
      for (const block of betaMsg.content) {
        if (block.type === 'text') {
          yield { type: 'text', text: block.text }
        } else if (block.type === 'thinking') {
          yield { type: 'thinking', text: block.thinking }
        }
      }
      if (msg.error) {
        yield { type: 'result', isError: true, errorMessage: msg.error }
      }
      break
    }

    case 'stream_event': {
      // SDKPartialAssistantMessage — raw Anthropic streaming events
      const event = (msg as any).event
      if (!event) break
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text }
        } else if (event.delta?.type === 'thinking_delta') {
          yield { type: 'thinking', text: event.delta.thinking }
        }
      }
      break
    }

    case 'tool_progress': {
      yield {
        type: 'tool_progress',
        toolId: msg.tool_use_id,
        toolName: msg.tool_name,
        elapsedSeconds: msg.elapsed_time_seconds,
      }
      break
    }

    case 'tool_use_summary': {
      // Emit as text — the summary is a human-readable description of what the tool did
      const summary = (msg as any).summary
      if (summary) {
        yield { type: 'text', text: summary }
      }
      break
    }

    case 'result': {
      const r = msg as any
      yield {
        type: 'result',
        isError: r.is_error ?? false,
        errorMessage: r.subtype === 'error' ? (r.error ?? 'Unknown error') : undefined,
        costUsd: r.total_cost_usd,
        durationMs: r.duration_ms,
        usage: r.usage ? {
          input_tokens: r.usage.input_tokens ?? 0,
          output_tokens: r.usage.output_tokens ?? 0,
          cache_read_input_tokens: r.usage.cache_read_input_tokens,
          cost_usd: r.total_cost_usd,
        } : undefined,
      }
      // Capture session_id from result
      if (r.session_id) {
        yield { type: 'status', sessionId: r.session_id }
      }
      break
    }

    // Ignore: user, system, auth_status, hook_*, task_*, compact_boundary, rate_limit, etc.
  }
}

// Self-register
registerAdapter('claude', createClaudeAdapter)

export { createClaudeAdapter }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit src/lib/server/agent-bridge/adapters/claude.ts 2>&1 | head -20
```

If there are type errors from the SDK, use `as any` at boundaries — the SDK types change frequently and we verified the structure from the .d.ts files.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/agent-bridge/adapters/claude.ts
git commit -m "feat(agent-bridge): add Claude Agent SDK adapter"
```

---

### Task 5: Codex adapter

**Files:**
- Create: `src/lib/server/agent-bridge/adapters/codex.ts`

- [ ] **Step 1: Create codex.ts**

```typescript
// src/lib/server/agent-bridge/adapters/codex.ts

import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, StreamParams, SessionInfo } from '../types.js'

function createCodexAdapter(): AgentAdapter {
  return {
    agent: 'codex',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      // Dynamic import — codex-sdk may not be installed in all environments
      const { Codex } = await import('@openai/codex-sdk')
      const { prompt, sessionId, model, cwd, abortSignal } = params

      const codex = new Codex({ model })
      const thread = sessionId
        ? codex.resumeThread(sessionId)
        : codex.startThread()

      const abortController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }

      try {
        const stream = thread.runStreamed(prompt, {
          abortController,
          cwd: cwd ?? process.env.HOME,
          approvalPolicy: 'on-request',
        })

        for await (const event of stream) {
          yield* translateCodexEvent(event)
        }
      } finally {
        yield { type: 'done' }
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // Codex stores sessions in ~/.codex/sessions/
      // For now return empty — can be implemented by reading directory
      return []
    },
  }
}

function* translateCodexEvent(event: any): Generator<AgentEvent> {
  // Codex SDK emits events with varying shapes — handle the common ones
  switch (event?.type) {
    case 'text':
    case 'message':
      if (event.text || event.content) {
        yield { type: 'text', text: event.text ?? event.content }
      }
      break

    case 'tool_use':
    case 'function_call':
      yield {
        type: 'tool_start',
        toolId: event.id ?? event.call_id ?? crypto.randomUUID(),
        toolName: event.name ?? event.function?.name ?? 'unknown',
        input: event.input ?? event.arguments ?? {},
      }
      break

    case 'tool_result':
    case 'function_result':
      yield {
        type: 'tool_end',
        toolId: event.tool_use_id ?? event.call_id ?? '',
        toolName: event.name ?? '',
        result: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        isError: event.is_error ?? false,
      }
      break

    case 'result':
    case 'done':
      yield {
        type: 'result',
        isError: event.is_error ?? false,
        errorMessage: event.error,
        usage: event.usage ? {
          input_tokens: event.usage.input_tokens ?? 0,
          output_tokens: event.usage.output_tokens ?? 0,
        } : undefined,
      }
      if (event.session_id || event.thread_id) {
        yield { type: 'status', sessionId: event.session_id ?? event.thread_id }
      }
      break
  }
}

// Self-register
registerAdapter('codex', createCodexAdapter)

export { createCodexAdapter }
```

Note: The Codex SDK API surface is less documented than Claude's. The event translation above covers the common patterns. Actual field names may need adjustment when testing against the real SDK.

- [ ] **Step 2: Commit**

```bash
git add src/lib/server/agent-bridge/adapters/codex.ts
git commit -m "feat(agent-bridge): add Codex SDK adapter"
```

---

### Task 6: Gemini adapter

**Files:**
- Create: `src/lib/server/agent-bridge/adapters/gemini.ts`

- [ ] **Step 1: Create gemini.ts**

```typescript
// src/lib/server/agent-bridge/adapters/gemini.ts

import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, StreamParams, SessionInfo } from '../types.js'

function createGeminiAdapter(): AgentAdapter {
  return {
    agent: 'gemini',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      // Dynamic import — gemini-cli-sdk may not be installed
      const { GeminiClient } = await import('@ketd/gemini-cli-sdk')
      const { prompt, sessionId, model, cwd, permissionCallback, abortSignal } = params

      const client = new GeminiClient({
        model,
        cwd: cwd ?? process.env.HOME,
        sessionId,
        onPermissionRequest: async (request: any) => {
          const result = await permissionCallback({
            id: request.id ?? crypto.randomUUID(),
            toolName: request.toolName ?? request.name ?? 'unknown',
            input: request.parameters ?? request.input ?? {},
          })
          return { approved: result.behavior === 'allow', reason: result.message }
        },
      })

      const abortController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }

      try {
        const stream = client.stream(prompt, { abortController })

        for await (const event of stream) {
          yield* translateGeminiEvent(event)
        }
      } finally {
        yield { type: 'done' }
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      return []
    },
  }
}

function* translateGeminiEvent(event: any): Generator<AgentEvent> {
  switch (event?.type) {
    case 'text':
    case 'message':
      if (event.text || event.content) {
        yield { type: 'text', text: event.text ?? event.content }
      }
      break

    case 'tool_use':
      yield {
        type: 'tool_start',
        toolId: event.id ?? crypto.randomUUID(),
        toolName: event.name ?? 'unknown',
        input: event.input ?? event.parameters ?? {},
      }
      break

    case 'tool_result':
      yield {
        type: 'tool_end',
        toolId: event.tool_use_id ?? event.id ?? '',
        toolName: event.name ?? '',
        result: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        isError: event.is_error ?? false,
      }
      break

    case 'result':
    case 'done':
      yield {
        type: 'result',
        isError: event.is_error ?? false,
        errorMessage: event.error,
      }
      if (event.session_id) {
        yield { type: 'status', sessionId: event.session_id }
      }
      break
  }
}

registerAdapter('gemini', createGeminiAdapter)

export { createGeminiAdapter }
```

Note: The `@ketd/gemini-cli-sdk` API is community-maintained and may differ from what's shown. The adapter will need adjustment when testing against the actual SDK. The pattern is the same as the other adapters.

- [ ] **Step 2: Commit**

```bash
git add src/lib/server/agent-bridge/adapters/gemini.ts
git commit -m "feat(agent-bridge): add Gemini CLI SDK adapter"
```

---

### Task 7: SvelteKit server routes

**Files:**
- Create: `src/routes/api/agent/stream/+server.ts`
- Create: `src/routes/api/agent/permission/+server.ts`
- Create: `src/routes/api/agent/sessions/+server.ts`

- [ ] **Step 1: Create the stream endpoint**

```typescript
// src/routes/api/agent/stream/+server.ts

// @ts-ignore
import type { RequestHandler } from './$types'
import { createAdapter } from '$lib/server/agent-bridge/adapter'
import { registerPending } from '$lib/server/agent-bridge/permission-manager'
import type { AgentType, Attachment } from '$lib/server/agent-bridge/types'

// Side-effect imports: trigger adapter self-registration
import '$lib/server/agent-bridge/adapters/claude'
import '$lib/server/agent-bridge/adapters/codex'
import '$lib/server/agent-bridge/adapters/gemini'

const VALID_AGENTS = new Set<AgentType>(['claude', 'codex', 'gemini'])

function getMcpServerUrl(): string {
  if (process.env.CATGO_API) return process.env.CATGO_API.replace(/\/$/, '') + '/mcp'
  const port = parseInt(process.env.SERVER_PORT ?? '8000', 10)
  return `http://localhost:${port}/api/mcp`
}

export const POST: RequestHandler = async ({ request }: { request: Request }) => {
  const body = await request.json()
  const { agent, prompt, sessionId, model, attachments } = body as {
    agent: string
    prompt: string
    sessionId?: string
    model?: string
    attachments?: Attachment[]
  }

  if (!VALID_AGENTS.has(agent as AgentType)) {
    return new Response(JSON.stringify({ error: `Invalid agent: ${agent}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!prompt?.trim()) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const adapter = createAdapter(agent as AgentType)
  const mcpServerUrl = getMcpServerUrl()

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const write = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }

      try {
        const gen = adapter.stream({
          prompt,
          sessionId,
          model,
          mcpServerUrl,
          attachments,
          permissionCallback: async (req) => {
            // Emit the permission request event to the SSE stream
            write({ type: 'permission_request', ...req })
            // Block until user resolves via POST /api/agent/permission
            return registerPending(req)
          },
          abortSignal: request.signal,
        })

        for await (const event of gen) {
          write(event)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Stream error'
        write({ type: 'result', isError: true, errorMessage: message })
        write({ type: 'done' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
```

- [ ] **Step 2: Create the permission resolve endpoint**

```typescript
// src/routes/api/agent/permission/+server.ts

// @ts-ignore
import type { RequestHandler } from './$types'
import { resolvePending } from '$lib/server/agent-bridge/permission-manager'

export const POST: RequestHandler = async ({ request }: { request: Request }) => {
  const { permissionId, behavior, suggestions } = await request.json() as {
    permissionId: string
    behavior: 'allow' | 'allow_session' | 'deny'
    suggestions?: unknown[]
  }

  if (!permissionId || !behavior) {
    return new Response(JSON.stringify({ error: 'permissionId and behavior are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const resolved = resolvePending(permissionId, behavior, suggestions)
  return new Response(JSON.stringify({ ok: resolved }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 3: Create the sessions list endpoint**

```typescript
// src/routes/api/agent/sessions/+server.ts

// @ts-ignore
import type { RequestHandler } from './$types'
import { createAdapter } from '$lib/server/agent-bridge/adapter'
import type { AgentType } from '$lib/server/agent-bridge/types'

import '$lib/server/agent-bridge/adapters/claude'
import '$lib/server/agent-bridge/adapters/codex'
import '$lib/server/agent-bridge/adapters/gemini'

export const GET: RequestHandler = async ({ url }: { url: URL }) => {
  const agent = url.searchParams.get('agent') as AgentType | null
  if (!agent || !['claude', 'codex', 'gemini'].includes(agent)) {
    return new Response(JSON.stringify({ error: 'Valid agent param required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const adapter = createAdapter(agent)
    const sessions = await adapter.listSessions()
    return new Response(JSON.stringify({ sessions }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/agent/
git commit -m "feat: add SvelteKit server routes for agent streaming, permissions, sessions"
```

---

### Task 8: Frontend types update

**Files:**
- Modify: `src/lib/chat/types.ts`

- [ ] **Step 1: Update LLMProvider type and add SDK_PROVIDERS**

In `src/lib/chat/types.ts`, replace the `LLMProvider` type and related items:

Replace:
```typescript
export type LLMProvider =
  | `anthropic`
  | `openai`
  | `deepseek`
  | `qwen`
  | `kimi`
  | `zhipu`
  | `gemini`
  | `ollama`
  | `cli-claude`
  | `cli-gemini`
  | `cli-codex`

/** Provider mode: direct browser API, backend proxy, CLI agent, or universal OpenAI-compat. */
export type ProviderMode = `direct` | `proxy` | `cli` | `universal`
```

With:
```typescript
export type LLMProvider =
  | `sdk-claude`
  | `sdk-codex`
  | `sdk-gemini`
  | `deepseek`
  | `qwen`
  | `kimi`
  | `zhipu`
  | `gemini`
  | `ollama`

/** Provider mode: Agent SDK or universal OpenAI-compat. */
export type ProviderMode = `sdk` | `universal`
```

Replace:
```typescript
/** CLI providers are free with Pro subscriptions */
export const CLI_PROVIDERS: Set<LLMProvider> = new Set([`cli-claude`, `cli-gemini`, `cli-codex`])
```

With:
```typescript
/** SDK agent providers — use Agent SDKs instead of direct API calls */
export const SDK_PROVIDERS: Set<LLMProvider> = new Set([`sdk-claude`, `sdk-codex`, `sdk-gemini`])
```

Replace the `default_mode_for` function:
```typescript
/** Determine the default mode for a provider */
export function default_mode_for(provider: LLMProvider): ProviderMode {
  if (SDK_PROVIDERS.has(provider)) return `sdk`
  return `universal`
}
```

Add the `AgentType` and `Attachment` types at the end of the file:

```typescript
export type AgentType = `claude` | `codex` | `gemini`

export interface Attachment {
  type: `image` | `pdf` | `file`
  name: string
  mimeType: string
  data: string // base64
}

/** Extract agent name from sdk-* provider */
export function agent_from_provider(provider: LLMProvider): AgentType | null {
  if (provider === `sdk-claude`) return `claude`
  if (provider === `sdk-codex`) return `codex`
  if (provider === `sdk-gemini`) return `gemini`
  return null
}
```

- [ ] **Step 2: Update DEFAULT_CONFIG in chat-state.svelte.ts**

In `src/lib/chat/chat-state.svelte.ts`, change the default config:

Replace:
```typescript
const DEFAULT_CONFIG: ChatConfig = {
  provider: `anthropic`,
  model: `claude-sonnet-4-20250514`,
  temperature: 0.3,
  max_tokens: 4096,
  api_key: ``,
  base_url: ``,
  mode: `direct`,
}
```

With:
```typescript
const DEFAULT_CONFIG: ChatConfig = {
  provider: `sdk-claude`,
  model: ``,
  temperature: 0.3,
  max_tokens: 4096,
  api_key: ``,
  base_url: ``,
  mode: `sdk`,
}
```

Also update imports at the top of `chat-state.svelte.ts`:

Replace:
```typescript
import { get_display_text, CLI_PROVIDERS } from './types'
```

With:
```typescript
import { get_display_text, SDK_PROVIDERS, agent_from_provider } from './types'
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/chat/types.ts src/lib/chat/chat-state.svelte.ts
git commit -m "feat: update provider types for SDK agents, remove old direct/cli modes"
```

---

### Task 9: Frontend SDK streaming client

**Files:**
- Create: `src/lib/chat/sdk-stream.ts`

- [ ] **Step 1: Create sdk-stream.ts**

```typescript
// src/lib/chat/sdk-stream.ts
//
// Frontend SSE parser for the unified /api/agent/stream endpoint.
// Yields AgentEvent objects from the SSE stream.

import type { AgentType, Attachment } from './types'

export interface AgentEvent {
  type: string
  [key: string]: unknown
}

export interface StreamAgentParams {
  agent: AgentType
  prompt: string
  sessionId?: string
  model?: string
  attachments?: Attachment[]
  signal?: AbortSignal
}

/**
 * Stream events from the Agent SDK bridge endpoint.
 * Yields parsed AgentEvent objects until the stream ends.
 */
export async function* stream_sdk_agent(
  params: StreamAgentParams,
): AsyncGenerator<AgentEvent> {
  const { agent, prompt, sessionId, model, attachments, signal } = params

  const response = await fetch(`/api/agent/stream`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ agent, prompt, sessionId, model, attachments }),
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

      // Process complete SSE events (delimited by \n\n)
      const parts = buffer.split(`\n\n`)
      // Keep the last incomplete part in the buffer
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

/**
 * Resolve a pending permission request.
 */
export async function resolve_permission(
  permissionId: string,
  behavior: `allow` | `allow_session` | `deny`,
  suggestions?: unknown[],
): Promise<boolean> {
  const resp = await fetch(`/api/agent/permission`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ permissionId, behavior, suggestions }),
  })
  if (!resp.ok) return false
  const data = await resp.json()
  return data.ok === true
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/chat/sdk-stream.ts
git commit -m "feat: add frontend SSE client for Agent SDK bridge"
```

---

### Task 10: PermissionCard component

**Files:**
- Create: `src/lib/chat/PermissionCard.svelte`

- [ ] **Step 1: Create PermissionCard.svelte**

```svelte
<script lang="ts">
  import { resolve_permission } from './sdk-stream'

  interface Props {
    permissionId: string
    toolName: string
    input: Record<string, unknown>
    suggestions?: unknown[]
    decisionReason?: string
  }

  let { permissionId, toolName, input, suggestions, decisionReason }: Props = $props()

  let status = $state<'pending' | 'allowed' | 'denied'>('pending')
  let resolving = $state(false)

  const input_summary = $derived(() => {
    const str = JSON.stringify(input, null, 2)
    return str.length > 400 ? str.slice(0, 400) + '...' : str
  })

  async function handle(behavior: 'allow' | 'allow_session' | 'deny') {
    if (resolving || status !== 'pending') return
    resolving = true
    const ok = await resolve_permission(permissionId, behavior, suggestions)
    if (ok) {
      status = behavior === 'deny' ? 'denied' : 'allowed'
    }
    resolving = false
  }
</script>

{#if status === 'pending'}
  <div class="permission-card pending">
    <div class="permission-header">Permission Required</div>
    <div class="permission-tool">Tool: <code>{toolName}</code></div>
    {#if decisionReason}
      <div class="permission-reason">{decisionReason}</div>
    {/if}
    <pre class="permission-input">{input_summary()}</pre>
    <div class="permission-actions">
      <button class="btn-allow" onclick={() => handle('allow')} disabled={resolving}>Allow</button>
      <button class="btn-allow-session" onclick={() => handle('allow_session')} disabled={resolving}>Allow Session</button>
      <button class="btn-deny" onclick={() => handle('deny')} disabled={resolving}>Deny</button>
    </div>
  </div>
{:else}
  <div class="permission-card {status}">
    <span class="permission-resolved-icon">{status === 'allowed' ? '\u2713' : '\u2717'}</span>
    <span>{status === 'allowed' ? 'Allowed' : 'Denied'}: {toolName}({Object.keys(input).length > 0 ? Object.keys(input)[0] + '...' : ''})</span>
  </div>
{/if}

<style>
  .permission-card {
    border-radius: 8px;
    padding: 12px;
    margin: 8px 0;
    font-size: 0.9em;
  }
  .permission-card.pending {
    border: 1px solid var(--warning-color, #f59e0b);
    background: var(--surface-2, #1e1e2e);
  }
  .permission-card.allowed {
    border: 1px solid var(--success-color, #22c55e);
    background: var(--surface-2, #1e1e2e);
    opacity: 0.7;
    padding: 6px 12px;
  }
  .permission-card.denied {
    border: 1px solid var(--error-color, #ef4444);
    background: var(--surface-2, #1e1e2e);
    opacity: 0.7;
    padding: 6px 12px;
  }
  .permission-header {
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--warning-color, #f59e0b);
  }
  .permission-tool {
    margin-bottom: 4px;
  }
  .permission-tool code {
    background: var(--surface-3, #2a2a3e);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .permission-reason {
    font-size: 0.85em;
    color: var(--text-muted, #888);
    margin-bottom: 4px;
  }
  .permission-input {
    background: var(--surface-3, #2a2a3e);
    padding: 8px;
    border-radius: 4px;
    font-size: 0.85em;
    overflow-x: auto;
    max-height: 200px;
    overflow-y: auto;
    margin: 8px 0;
  }
  .permission-actions {
    display: flex;
    gap: 8px;
  }
  .permission-actions button {
    padding: 4px 16px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 500;
  }
  .btn-allow { background: var(--success-color, #22c55e); color: white; }
  .btn-allow-session { background: var(--info-color, #3b82f6); color: white; }
  .btn-deny { background: var(--error-color, #ef4444); color: white; }
  .permission-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .permission-resolved-icon { margin-right: 6px; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/chat/PermissionCard.svelte
git commit -m "feat: add PermissionCard component for inline tool approval"
```

---

### Task 11: ToolProgressBlock component

**Files:**
- Create: `src/lib/chat/ToolProgressBlock.svelte`

- [ ] **Step 1: Create ToolProgressBlock.svelte**

```svelte
<script lang="ts">
  interface Props {
    toolId: string
    toolName: string
    input?: unknown
    output?: string
    status: 'running' | 'complete' | 'error'
    elapsedSeconds?: number
  }

  let { toolId, toolName, input, output, status, elapsedSeconds }: Props = $props()

  let expanded = $state(status === 'running')

  const status_icon = $derived(
    status === 'running' ? '\u25B6' : status === 'complete' ? '\u2713' : '\u2717'
  )
  const status_class = $derived(status)

  const input_summary = $derived(() => {
    if (!input) return ''
    const str = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return str.length > 300 ? str.slice(0, 300) + '...' : str
  })

  const elapsed_display = $derived(() => {
    if (!elapsedSeconds) return ''
    return elapsedSeconds < 1 ? `${Math.round(elapsedSeconds * 1000)}ms` : `${elapsedSeconds.toFixed(1)}s`
  })
</script>

<div class="tool-block {status_class}" role="group">
  <button class="tool-header" onclick={() => expanded = !expanded}>
    <span class="tool-icon {status_class}">{status_icon}</span>
    <span class="tool-name">{toolName}</span>
    {#if elapsed_display()}
      <span class="tool-elapsed">{elapsed_display()}</span>
    {/if}
    <span class="tool-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
  </button>

  {#if expanded}
    <div class="tool-detail">
      {#if input_summary()}
        <div class="tool-section">
          <div class="tool-section-label">Input</div>
          <pre class="tool-pre">{input_summary()}</pre>
        </div>
      {/if}
      {#if output}
        <div class="tool-section">
          <div class="tool-section-label">Output</div>
          <pre class="tool-pre">{output.length > 2000 ? output.slice(0, 2000) + '\n... (truncated)' : output}</pre>
        </div>
      {/if}
      {#if status === 'running' && !output}
        <div class="tool-running-indicator">Running...</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-block {
    border-radius: 6px;
    margin: 4px 0;
    border: 1px solid var(--surface-3, #2a2a3e);
    overflow: hidden;
  }
  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: var(--surface-2, #1e1e2e);
    border: none;
    cursor: pointer;
    font-size: 0.85em;
    color: inherit;
    text-align: left;
  }
  .tool-icon {
    font-size: 0.75em;
  }
  .tool-icon.running { color: var(--info-color, #3b82f6); }
  .tool-icon.complete { color: var(--success-color, #22c55e); }
  .tool-icon.error { color: var(--error-color, #ef4444); }
  .tool-name { font-family: monospace; font-weight: 500; flex: 1; }
  .tool-elapsed { color: var(--text-muted, #888); font-size: 0.85em; }
  .tool-chevron { color: var(--text-muted, #888); font-size: 0.7em; }
  .tool-detail {
    padding: 8px 10px;
    background: var(--surface-1, #171728);
  }
  .tool-section { margin-bottom: 8px; }
  .tool-section-label {
    font-size: 0.75em;
    text-transform: uppercase;
    color: var(--text-muted, #888);
    margin-bottom: 4px;
  }
  .tool-pre {
    background: var(--surface-3, #2a2a3e);
    padding: 8px;
    border-radius: 4px;
    font-size: 0.8em;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    margin: 0;
  }
  .tool-running-indicator {
    color: var(--info-color, #3b82f6);
    font-size: 0.85em;
    font-style: italic;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/chat/ToolProgressBlock.svelte
git commit -m "feat: add ToolProgressBlock component for tool execution detail"
```

---

### Task 12: Wire chat-state.svelte.ts to SDK streaming

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts`

This is the core integration task. Replace the CLI streaming path with the SDK path.

- [ ] **Step 1: Add SDK streaming in send_message()**

In `src/lib/chat/chat-state.svelte.ts`, add the import at the top:

```typescript
import { stream_sdk_agent } from './sdk-stream'
import type { AgentEvent } from './sdk-stream'
```

Then replace the body of `send_message()` from the `try {` block. The new `send_message` should handle SDK providers using the new stream, and fall through to the existing `stream_chat()` for universal providers.

Replace the `try { ... }` block inside `send_message()` (from `// RAG retrieval` through the end of the try block):

```typescript
    // Determine path
    const agent = agent_from_provider(chat_config.provider)

    if (agent) {
      // ── SDK Agent path ──
      const sid = agent_sessions[agent] || undefined
      const gen = stream_sdk_agent({
        agent,
        prompt: content.trim(),
        sessionId: sid,
        model: chat_config.model || undefined,
        signal: abort_controller!.signal,
      })

      let full_text = ``
      for await (const event of gen) {
        switch (event.type) {
          case `text`:
            full_text += event.text as string
            update_last_message(full_text)
            break
          case `status`:
            if (event.sessionId) {
              agent_sessions[agent] = event.sessionId as string
              record_session(agent, event.sessionId as string, content)
            }
            break
          case `result`:
            // result event handled — nothing to update in UI beyond what text already shows
            break
          // permission_request, tool_start, tool_progress, tool_end
          // are handled by ChatPane.svelte rendering PermissionCard and ToolProgressBlock
          // We store them as structured content blocks in the message
        }
      }
    } else {
      // ── Universal (OpenAI-compat) path — unchanged ──
      const rag_chunks = await retrieve(content, 5)
      const combined_context = [structure_context.value, workflow_context.value, paper_context.value]
        .filter(Boolean)
        .join(`\n\n`) || undefined

      const stream = stream_chat(
        chat_messages.list.slice(0, -1),
        chat_config,
        rag_chunks,
        abort_controller!.signal,
        combined_context,
      )

      let full_text = ``
      for await (const chunk of stream) {
        full_text += chunk
        update_last_message(full_text)
      }
    }
```

- [ ] **Step 2: Rename cli_sessions to agent_sessions**

Replace:
```typescript
export const cli_sessions = $state<Record<string, string>>({})

export function set_cli_session(agent: string, session_id: string): void {
  cli_sessions[agent] = session_id
}

export function clear_cli_session(agent?: string): void {
  if (agent) {
    delete cli_sessions[agent]
  } else {
    for (const key of Object.keys(cli_sessions)) delete cli_sessions[key]
  }
}
```

With:
```typescript
export const agent_sessions = $state<Record<string, string>>({})

export function set_agent_session(agent: string, session_id: string): void {
  agent_sessions[agent] = session_id
}

export function clear_agent_session(agent?: string): void {
  if (agent) {
    delete agent_sessions[agent]
  } else {
    for (const key of Object.keys(agent_sessions)) delete agent_sessions[key]
  }
}
```

Update all references to `cli_sessions` → `agent_sessions`, `set_cli_session` → `set_agent_session`, `clear_cli_session` → `clear_agent_session` throughout the file and in `llm-client.ts`.

- [ ] **Step 3: Remove the fire-and-forget CLI sync block in finally**

Remove the entire `if (CLI_PROVIDERS.has(chat_config.provider)) { ... }` block in the `finally` clause — SDK sessions don't need fire-and-forget sync because events come through the stream directly.

- [ ] **Step 4: Verify the build compiles**

```bash
pnpm check 2>&1 | head -30
```

Fix any type errors. Many will come from references to removed types (`CLI_PROVIDERS`, `cli_sessions`, old provider names). Track them down and update.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts src/lib/chat/llm-client.ts
git commit -m "feat: wire chat-state to SDK streaming, rename cli_sessions to agent_sessions"
```

---

### Task 13: Attachment UI in ChatPane

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte`

- [ ] **Step 1: Add attachment state and handlers**

At the top of the `<script>` block, add:

```typescript
import type { Attachment } from './types'

let pending_attachments = $state<Attachment[]>([])
let file_input_el: HTMLInputElement

function add_file(file: File): void {
  const MAX_SIZE = 20 * 1024 * 1024 // 20MB
  if (file.size > MAX_SIZE) {
    chat_error.value = `File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB, max 20MB)`
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const base64 = (reader.result as string).split(',')[1]
    const att_type = file.type.startsWith('image/') ? 'image'
      : file.type === 'application/pdf' ? 'pdf'
      : 'file'
    pending_attachments = [...pending_attachments, {
      type: att_type,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: base64,
    }]
  }
  reader.readAsDataURL(file)
}

function remove_attachment(idx: number): void {
  pending_attachments = pending_attachments.filter((_, i) => i !== idx)
}

function handle_file_input(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files) {
    for (const f of input.files) add_file(f)
  }
  input.value = ''
}

function handle_drop(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer?.files) {
    for (const f of e.dataTransfer.files) add_file(f)
  }
}

function handle_paste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) {
        e.preventDefault()
        add_file(file)
      }
    }
  }
}
```

- [ ] **Step 2: Add attachment preview strip and file input to the template**

Above the input textarea, add:

```svelte
<!-- Attachment preview strip -->
{#if pending_attachments.length > 0}
  <div class="attachment-strip">
    {#each pending_attachments as att, idx}
      <div class="attachment-chip">
        <span class="att-icon">
          {att.type === 'image' ? '\uD83D\uDDBC' : att.type === 'pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCC1'}
        </span>
        <span class="att-name">{att.name.length > 20 ? att.name.slice(0, 17) + '...' : att.name}</span>
        <button class="att-remove" onclick={() => remove_attachment(idx)}>\u00D7</button>
      </div>
    {/each}
  </div>
{/if}

<!-- Hidden file input -->
<input
  bind:this={file_input_el}
  type="file"
  multiple
  accept="image/*,.pdf,.cif,.xyz,.poscar,.vasp,*"
  style="display:none"
  onchange={handle_file_input}
/>
```

Next to the send button, add the attachment button:

```svelte
<button class="btn-attach" onclick={() => file_input_el?.click()} title="Attach files">
  \uD83D\uDCCE
</button>
```

Add `ondrop={handle_drop}` and `ondragover={(e) => e.preventDefault()}` to the input area container. Add `onpaste={handle_paste}` to the textarea.

- [ ] **Step 3: Pass attachments through send_message()**

When the user clicks send, pass `pending_attachments` and clear them. This requires updating `send_message()` to accept attachments and forward them to `stream_sdk_agent()`.

In `chat-state.svelte.ts`, update `send_message` signature:

```typescript
export async function send_message(
  content: string,
  tool_executor?: ToolExecutor,
  attachments?: Attachment[],
): Promise<void> {
```

And pass `attachments` to `stream_sdk_agent()`:

```typescript
const gen = stream_sdk_agent({
  agent,
  prompt: content.trim(),
  sessionId: sid,
  model: chat_config.model || undefined,
  attachments,
  signal: abort_controller!.signal,
})
```

In `ChatPane.svelte`, update the send handler to pass and clear attachments:

```typescript
async function do_send() {
  const atts = pending_attachments.length > 0 ? [...pending_attachments] : undefined
  pending_attachments = []
  await send_message(input_text, tool_executor, atts)
}
```

- [ ] **Step 4: Add attachment strip styles**

```css
.attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--surface-3, #2a2a3e);
}
.attachment-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-3, #2a2a3e);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 0.8em;
}
.att-icon { font-size: 1em; }
.att-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-remove {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  padding: 0 2px;
  font-size: 1.1em;
}
.btn-attach {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.2em;
  padding: 4px;
  opacity: 0.7;
}
.btn-attach:hover { opacity: 1; }
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/ChatPane.svelte src/lib/chat/chat-state.svelte.ts
git commit -m "feat: add attachment UI (file picker, drag-drop, paste, preview strip)"
```

---

### Task 14: Render PermissionCard and ToolProgressBlock in ChatPane

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte`

- [ ] **Step 1: Import new components**

```typescript
import PermissionCard from './PermissionCard.svelte'
import ToolProgressBlock from './ToolProgressBlock.svelte'
```

- [ ] **Step 2: Handle SDK events in the message rendering**

The SDK stream emits `permission_request`, `tool_start`, `tool_progress`, `tool_end` events. We need to store these as inline blocks in the assistant message and render them.

In `chat-state.svelte.ts`, extend the SDK streaming loop to track tool/permission state. Add a per-message state tracker:

```typescript
// Inside the SDK agent path in send_message():
const tool_blocks = new Map<string, { toolName: string; input: unknown; output: string; status: string; elapsedSeconds: number }>()
const permission_blocks = new Map<string, { toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; decisionReason?: string; status: string }>()

for await (const event of gen) {
  switch (event.type) {
    case `text`:
      full_text += event.text as string
      update_last_message(full_text)
      break
    case `thinking`:
      // Optionally show thinking in a collapsed block
      break
    case `tool_start`:
      tool_blocks.set(event.toolId as string, {
        toolName: event.toolName as string,
        input: event.input,
        output: ``,
        status: `running`,
        elapsedSeconds: 0,
      })
      // Force re-render
      chat_messages.list = [...chat_messages.list]
      break
    case `tool_progress`:
      const tb = tool_blocks.get(event.toolId as string)
      if (tb) {
        tb.elapsedSeconds = event.elapsedSeconds as number
        tb.status = `running`
        chat_messages.list = [...chat_messages.list]
      }
      break
    case `tool_end`:
      const te = tool_blocks.get(event.toolId as string)
      if (te) {
        te.output = event.result as string
        te.status = (event.isError as boolean) ? `error` : `complete`
        te.toolName = (event.toolName as string) || te.toolName
        chat_messages.list = [...chat_messages.list]
      }
      break
    case `permission_request`:
      permission_blocks.set(event.id as string, {
        toolName: event.toolName as string,
        input: event.input as Record<string, unknown>,
        suggestions: event.suggestions as unknown[] | undefined,
        decisionReason: event.decisionReason as string | undefined,
        status: `pending`,
      })
      chat_messages.list = [...chat_messages.list]
      break
    case `permission_resolved`:
      const pb = permission_blocks.get(event.id as string)
      if (pb) {
        pb.status = (event.behavior as string) === `deny` ? `denied` : `allowed`
        chat_messages.list = [...chat_messages.list]
      }
      break
    case `status`:
      if (event.sessionId) {
        agent_sessions[agent] = event.sessionId as string
        record_session(agent, event.sessionId as string, content)
      }
      break
  }
}
```

The exact rendering mechanism (how tool_blocks and permission_blocks are exposed to ChatPane for rendering) should use a shared reactive store or be embedded as structured content in the assistant message. The simplest approach: store them in module-level reactive state that ChatPane reads.

Add to `chat-state.svelte.ts`:

```typescript
/** Active tool and permission blocks for the current streaming message */
export const active_tool_blocks = $state<Map<string, { toolName: string; input: unknown; output: string; status: string; elapsedSeconds: number }>>(new Map())
export const active_permission_blocks = $state<Map<string, { toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; decisionReason?: string; status: string }>>(new Map())
```

Clear them at the start of `send_message()` and populate them during streaming. ChatPane iterates them to render PermissionCard and ToolProgressBlock below the current assistant message.

- [ ] **Step 3: Render in ChatPane**

After the assistant message text, render any active blocks:

```svelte
{#if msg.role === 'assistant' && idx === chat_messages.list.length - 1}
  {#each [...$active_permission_blocks] as [id, pb]}
    <PermissionCard
      permissionId={id}
      toolName={pb.toolName}
      input={pb.input}
      suggestions={pb.suggestions}
      decisionReason={pb.decisionReason}
    />
  {/each}
  {#each [...$active_tool_blocks] as [id, tb]}
    <ToolProgressBlock
      toolId={id}
      toolName={tb.toolName}
      input={tb.input}
      output={tb.output}
      status={tb.status}
      elapsedSeconds={tb.elapsedSeconds}
    />
  {/each}
{/if}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/chat/ChatPane.svelte src/lib/chat/chat-state.svelte.ts
git commit -m "feat: render PermissionCard and ToolProgressBlock inline in chat"
```

---

### Task 15: Update message-utils.ts for new providers

**Files:**
- Modify: `src/lib/chat/message-utils.ts`

- [ ] **Step 1: Update PROVIDER_META and AGENT_LABELS**

Add entries for `sdk-claude`, `sdk-codex`, `sdk-gemini` to the existing `PROVIDER_META` map. Remove entries for `anthropic`, `openai`, `cli-claude`, `cli-gemini`, `cli-codex`.

Find the `PROVIDER_META` object and add:

```typescript
'sdk-claude': { label: 'Claude Code', icon: '🤖', color: '#d4a574' },
'sdk-codex': { label: 'Codex', icon: '💻', color: '#10a37f' },
'sdk-gemini': { label: 'Gemini', icon: '✨', color: '#4285f4' },
```

Update `AGENT_LABELS` similarly:

```typescript
claude: 'Claude Code',
codex: 'Codex',
gemini: 'Gemini',
```

- [ ] **Step 2: Update any CLI_PROVIDERS references**

Search for `CLI_PROVIDERS` in `message-utils.ts` and replace with `SDK_PROVIDERS`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/chat/message-utils.ts
git commit -m "feat: update provider metadata for SDK agents"
```

---

### Task 16: End-to-end test with Claude SDK

- [ ] **Step 1: Start the Python backend**

```bash
python server/main.py &
```

Wait for MCP server to be ready.

- [ ] **Step 2: Start the SvelteKit dev server**

```bash
pnpm dev
```

- [ ] **Step 3: Test in browser**

1. Open CatGo in browser
2. Select `sdk-claude` (should be default)
3. Send a message: "What files are in the current directory?"
4. Verify: streaming response appears, session ID captured
5. Send a follow-up: "Read the first file" — should trigger a tool call
6. Verify: ToolProgressBlock appears showing the Read tool
7. If permission prompt appears: verify PermissionCard renders, click Allow, stream resumes

- [ ] **Step 4: Test session resume**

1. Note the session ID from the first test
2. Refresh the page
3. Go to Sessions tab, find and resume the session
4. Send another message — should resume without cold start

- [ ] **Step 5: Document any issues found and fix them**

Fix type mismatches, event mapping issues, or rendering glitches found during testing.

- [ ] **Step 6: Commit fixes**

```bash
git add -u
git commit -m "fix: resolve issues found during Claude SDK end-to-end testing"
```

---

### Task 17: Clean up dead code

**Files to remove or gut:** As listed in the spec's "Code to Remove" section. Only do this after Tasks 1-16 are verified working.

- [ ] **Step 1: Remove old CLI agent backend code**

This is Python backend code that's no longer called:
- `server/catgo/routers/chat_multi/cli_agents.py` — the entire file (subprocess spawning)
- In `server/catgo/routers/chat_multi/providers.py` — remove `CLI_AGENTS` dict, `_build_cli_command()`, `_ensure_catbot_sandbox()`, related imports
- In `server/catgo/routers/chat_multi/__init__.py` — remove the `/stream-cli-agent` endpoint

- [ ] **Step 2: Remove old frontend tool definitions and executors**

These are only used by the removed `direct` and `cli` paths:
- `src/lib/chat/structure-tools.ts` — entire file
- `src/lib/chat/structure-tool-executor.ts` — entire file
- `src/lib/chat/workflow-tool-executor.ts` — entire file
- `src/lib/chat/file-tools.ts` — entire file
- `src/lib/chat/file-tool-executor.ts` — entire file

- [ ] **Step 3: Remove old streaming functions from llm-client.ts**

Remove:
- `stream_anthropic_direct()`
- `stream_openai_direct()`
- `stream_proxy()`
- `stream_cli_agent()`
- `stream_chat_with_tools()`
- `parse_sse_cli()`
- Related helper functions only used by removed code

Keep:
- `stream_chat()` — still used by universal path
- `stream_chat_with_tools_universal()` — still used by universal path
- `fetch_providers()` — still needed
- `parse_sse()` — still used

- [ ] **Step 4: Remove run_tool_loop and old imports from chat-state.svelte.ts**

Remove:
- `run_tool_loop()` function
- Imports of removed modules (`STRUCTURE_TOOL_DEFINITIONS`, `FILE_TOOL_DEFINITIONS`, `is_file_tool`, `execute_file_tool`, etc.)
- The `tool_executor` parameter from `send_message()` (no longer needed — tools execute through SDK)

- [ ] **Step 5: Remove tool registration from Structure.svelte and WorkflowEditor.svelte**

Remove `register_structure_action_handler()` calls and related handler functions.

- [ ] **Step 6: Verify build still compiles**

```bash
pnpm check 2>&1 | head -30
```

Fix any remaining references to removed code.

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "refactor: remove old subprocess CLI agents, direct API, and frontend tool definitions

Removes ~2000 lines: structure-tools.ts, structure-tool-executor.ts,
workflow-tool-executor.ts, file-tools.ts, file-tool-executor.ts,
cli_agents.py, run_tool_loop(), stream_anthropic_direct(),
stream_cli_agent(), and related dead code.

All tool execution now goes through Agent SDK → MCP."
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Install SDK deps | `package.json` |
| 2 | Types + adapter interface | `agent-bridge/types.ts`, `adapter.ts` |
| 3 | Permission manager | `agent-bridge/permission-manager.ts` |
| 4 | Claude adapter | `agent-bridge/adapters/claude.ts` |
| 5 | Codex adapter | `agent-bridge/adapters/codex.ts` |
| 6 | Gemini adapter | `agent-bridge/adapters/gemini.ts` |
| 7 | SvelteKit routes | `routes/api/agent/**` |
| 8 | Frontend types update | `types.ts`, `chat-state.svelte.ts` |
| 9 | SDK SSE client | `sdk-stream.ts` |
| 10 | PermissionCard | `PermissionCard.svelte` |
| 11 | ToolProgressBlock | `ToolProgressBlock.svelte` |
| 12 | Wire chat-state to SDK | `chat-state.svelte.ts` |
| 13 | Attachment UI | `ChatPane.svelte` |
| 14 | Render cards in chat | `ChatPane.svelte`, `chat-state.svelte.ts` |
| 15 | Provider metadata | `message-utils.ts` |
| 16 | E2E test | Manual verification |
| 17 | Remove dead code | ~10 files removed |
