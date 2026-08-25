/**
 * Gemini CLI adapter — talks to `gemini --acp` over JSON-RPC stdio.
 *
 * Two modes, selected by whether `StreamParams.chatId` is present:
 *
 *  • Persistent (chatId set): a {@link GeminiProcessPool} keeps one
 *    `gemini --acp` process + ACP session alive per chat tab, so the model
 *    remembers prior turns and tool results — matching the Claude / Codex
 *    adapters whose SDKs persist their subprocess. Idle tabs evict; crashed
 *    processes respawn with a one-line context-reset notice.
 *
 *  • One-shot (chatId absent): spawn a fresh process, run the single prompt,
 *    tear it down. Legacy behaviour — keeps non-pooled callers and tests
 *    cheap and unaffected.
 *
 * ACP is the official IPC mode Gemini CLI 0.41+ exposes for IDE / SDK
 * embedding: newline-delimited JSON-RPC 2.0 over stdin/stdout. The JSON-RPC
 * client + spawn handshake live in `../acp/client.ts`; the ACP⇄AgentEvent
 * translation in `../acp/translate.ts`; the pool in `../acp/process-pool.ts`.
 */

import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, SessionInfo, StreamParams } from '../types.js'
import { GeminiCliNotFoundError, spawn_gemini_acp } from '../acp/client.js'
import { mapPermissionRequest, translateUpdate } from '../acp/translate.js'
import { decide_tool_permission } from './claude.js'
import { GeminiProcessPool } from '../acp/process-pool.js'
import {
  attachmentPathContext,
  materializeAttachments,
  type MaterializedAttachment,
} from '../attachments.js'

// One pool per agent-bridge process. Shut down on SIGTERM by server.ts.
let pool = new GeminiProcessPool()

export function buildGeminiPromptBlocks(
  prompt: string,
  systemPrompt: string | undefined,
  attachments: MaterializedAttachment[],
): Array<Record<string, unknown>> {
  const fallback = attachments.filter((attachment) => !attachment.mimeType.startsWith('image/'))
  const pathContext = attachmentPathContext(fallback)
  const userText = pathContext ? `${prompt}\n\n${pathContext}` : prompt
  const fullText = systemPrompt
    ? `[System Context]\n${systemPrompt}\n\n[User]\n${userText}`
    : userText
  return [
    { type: 'text', text: fullText },
    ...attachments
      .filter((attachment) => attachment.mimeType.startsWith('image/'))
      .map((attachment) => ({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mimeType,
      })),
  ]
}

export function shutdownGeminiPool(): Promise<void> {
  return pool.shutdown()
}

/** Test seam: tear the pool down and start a fresh one. */
export async function resetGeminiPoolForTests(): Promise<void> {
  await pool.shutdown()
  pool = new GeminiProcessPool()
}

// ────────────────────────────────────────────────────────────────────────────
// Small queue that bridges async ACP notifications → an async generator.
// ────────────────────────────────────────────────────────────────────────────

class EventPump {
  private q: AgentEvent[] = []
  private wake: (() => void) | null = null
  private done = false

  push(e: AgentEvent): void {
    this.q.push(e)
    this.fire()
  }

  finish(): void {
    this.done = true
    this.fire()
  }

  private fire(): void {
    if (this.wake) {
      const w = this.wake
      this.wake = null
      w()
    }
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    while (!this.done || this.q.length > 0) {
      if (this.q.length > 0) {
        yield this.q.shift()!
        continue
      }
      if (this.done) break
      await new Promise<void>((r) => { this.wake = r })
    }
  }
}

function buildPermissionOutcome(
  rpcParams: any,
  permissionCallback: StreamParams['permissionCallback'],
  skipPermissions: boolean | undefined,
) {
  const tc = rpcParams?.toolCall ?? rpcParams ?? {}
  const toolName = String(tc.title ?? tc.kind ?? tc.toolName ?? '')
  const toolId = String(tc.toolCallId ?? tc.id ?? '')

  // Auto-allow CatGo MCP tools (same policy as the Claude adapter). Gemini's
  // ACP renders these as title "catgo_view (catgo MCP Server)" /
  // toolCallId "mcp_catgo_catgo_view__…". Without this the tool call blocks on
  // a frontend permission round-trip that never resolves in a popout/standalone
  // window — the model then sits at "处理中" forever.
  if (
    decide_tool_permission(toolName, skipPermissions) === 'allow' ||
    toolName.includes('catgo') ||
    toolId.includes('catgo')
  ) {
    return Promise.resolve(mapPermissionRequest(rpcParams, 'allow'))
  }

  return permissionCallback({
    id: toolId,
    toolName,
    input: tc.input ?? {},
  }).then((result) =>
    mapPermissionRequest(rpcParams, result.behavior === 'allow' ? 'allow' : 'deny'),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

export function createGeminiAdapter(): AgentAdapter {
  return {
    agent: 'gemini',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const materialized = materializeAttachments(
        params.attachments,
        params.cwd ?? process.cwd(),
      )
      try {
        if (params.chatId) {
          yield* streamPersistent(params, params.chatId, materialized.entries)
        } else {
          yield* streamOneShot(params, materialized.entries)
        }
      } finally {
        materialized.cleanup()
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // ACP exposes session/load but no session-list method yet.
      return []
    },
  }
}

// ── Persistent (pooled) path ────────────────────────────────────────────────

async function* streamPersistent(
  params: StreamParams,
  chatId: string,
  attachments: MaterializedAttachment[],
): AsyncGenerator<AgentEvent> {
  const { prompt, model, cwd, mcpServerUrl, permissionCallback, abortSignal, tabId, systemPrompt, skipPermissions } = params

  let handle
  try {
    handle = await pool.acquire(chatId, { cwd, mcpServerUrl, tabId, model })
  } catch (e) {
    const msg = e instanceof GeminiCliNotFoundError
      ? e.message
      : `Failed to start Gemini: ${e instanceof Error ? e.message : String(e)}`
    yield { type: 'result', isError: true, errorMessage: msg }
    yield { type: 'done' }
    return
  }

  const pump = new EventPump()
  const stop = { reason: undefined as string | undefined, err: null as Error | null }

  handle.onNotification = (notifParams: any) => {
    for (const ev of translateUpdate(notifParams?.update)) pump.push(ev)
  }
  handle.onPermission = (rpcParams: any) => buildPermissionOutcome(rpcParams, permissionCallback, skipPermissions)

  const onAbort = () => {
    handle.client.notify('session/cancel', { sessionId: handle.sessionId })
    // Don't shutdown the process — abort cancels the turn, the pool keeps
    // the process for the next prompt. The prompt request rejects, which
    // ends this stream.
  }
  if (abortSignal) {
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    // One-time context-reset banner after an unexpected prior crash.
    if (handle.crashedBefore) {
      handle.crashedBefore = false
      yield {
        type: 'thinking',
        text: '⚠️ Previous Gemini session ended unexpectedly — context reset.',
      }
    }

    yield { type: 'status', sessionId: handle.sessionId, model: model ?? undefined }

    const promptPromise = handle.client
      .request<{ stopReason?: string }>('session/prompt', {
        sessionId: handle.sessionId,
        prompt: buildGeminiPromptBlocks(prompt, systemPrompt, attachments),
      })
      .then((res) => { stop.reason = res?.stopReason })
      .catch((e: Error) => { stop.err = e })
      .finally(() => pump.finish())

    for await (const ev of pump.drain()) yield ev
    await promptPromise
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
    pool.release(handle)
  }

  yield* finalEvents(stop)
}

// ── One-shot (legacy) path ──────────────────────────────────────────────────

async function* streamOneShot(
  params: StreamParams,
  attachments: MaterializedAttachment[],
): AsyncGenerator<AgentEvent> {
  const {
    prompt, sessionId, model, cwd, mcpServerUrl, permissionCallback, abortSignal, tabId, systemPrompt,
    skipPermissions,
  } = params

  let spawned
  try {
    spawned = await spawn_gemini_acp({ cwd, model })
  } catch (e) {
    const msg = e instanceof GeminiCliNotFoundError
      ? e.message
      : `Failed to start Gemini: ${e instanceof Error ? e.message : String(e)}`
    yield { type: 'result', isError: true, errorMessage: msg }
    yield { type: 'done' }
    return
  }

  const { client } = spawned
  const pump = new EventPump()
  const stop = { reason: undefined as string | undefined, err: null as Error | null }

  client.onNotification('session/update', (notifParams: any) => {
    for (const ev of translateUpdate(notifParams?.update)) pump.push(ev)
  })
  client.onRequest('session/request_permission', (rpcParams: any) =>
    buildPermissionOutcome(rpcParams, permissionCallback, skipPermissions),
  )

  const onAbort = () => {
    if (sessionId) client.notify('session/cancel', { sessionId })
    client.shutdown()
  }
  if (abortSignal) {
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const mcpServers: any[] = []
    if (mcpServerUrl) {
      const headers: { name: string; value: string }[] = []
      if (tabId) headers.push({ name: 'X-CatGo-Tab-Id', value: tabId })
      mcpServers.push({ type: 'http', name: 'catgo', url: mcpServerUrl, headers })
    }
    const newSession = await client.request<{ sessionId: string }>('session/new', {
      cwd: cwd ?? process.cwd(),
      mcpServers,
    })
    const effectiveSessionId = newSession?.sessionId ?? sessionId ?? ''

    yield { type: 'status', sessionId: effectiveSessionId, model: model ?? undefined }

    const promptPromise = client
      .request<{ stopReason?: string }>('session/prompt', {
        sessionId: effectiveSessionId,
        prompt: buildGeminiPromptBlocks(prompt, systemPrompt, attachments),
      })
      .then((res) => { stop.reason = res?.stopReason })
      .catch((e: Error) => { stop.err = e })
      .finally(() => pump.finish())

    for await (const ev of pump.drain()) yield ev
    await promptPromise
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
    client.shutdown()
  }

  yield* finalEvents(stop)
}

function* finalEvents(stop: { reason?: string; err: Error | null }): Generator<AgentEvent> {
  if (stop.err) {
    yield { type: 'result', isError: true, errorMessage: stop.err.message }
  } else {
    yield {
      type: 'result',
      isError: stop.reason === 'refusal',
      errorMessage:
        stop.reason === 'max_tokens'
          ? 'Reached model max_tokens'
          : stop.reason === 'max_turn_requests'
          ? 'Reached max turn requests'
          : stop.reason === 'refusal'
          ? 'Model refused to continue'
          : undefined,
    }
  }
  yield { type: 'done' }
}

registerAdapter('gemini', createGeminiAdapter)
