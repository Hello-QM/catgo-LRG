/**
 * Gemini CLI adapter — talks to `gemini --acp` over JSON-RPC stdio.
 *
 * Replaces the deprecated `@ketd/gemini-cli-sdk` (third-party, unmaintained,
 * one-shot spawn per prompt) with a direct ACP (Agent Client Protocol)
 * integration. ACP is the official IPC mode Gemini CLI 0.41+ exposes for
 * IDE / SDK embedding:
 *
 *   1. Spawn `gemini --acp` once per `stream()` call.
 *   2. JSON-RPC 2.0 messages over stdin/stdout (\n-delimited).
 *   3. `initialize` → `session/new` (carries the CatGo MCP server URL +
 *      `X-CatGo-Tab-Id` header so structure pushes land in the originating
 *      tab) → `session/prompt`.
 *   4. Agent streams `session/update` notifications (text deltas, tool
 *      calls, plans, thoughts).
 *   5. Agent calls `session/request_permission` for tool approvals; we
 *      bridge to the StreamParams.permissionCallback.
 *   6. `session/prompt` resolves with `{ stopReason }` — emit `result` +
 *      `done` and tear the subprocess down.
 *
 * Tested against gemini-cli 0.41.x. Drops the @ketd/gemini-cli-sdk dep.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, SessionInfo, StreamParams } from '../types.js'

// ────────────────────────────────────────────────────────────────────────────
// CLI lookup
// ────────────────────────────────────────────────────────────────────────────

let _gemini_cli_path: string | null | undefined
function find_gemini_cli(): string | null {
  if (_gemini_cli_path !== undefined) return _gemini_cli_path
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = spawnSync(cmd, ['gemini'], { encoding: 'utf-8' })
    if (out.status === 0) {
      const first = out.stdout.split(/\r?\n/).find(Boolean)
      _gemini_cli_path = first?.trim() || null
      return _gemini_cli_path
    }
  } catch { /* fall through */ }
  _gemini_cli_path = null
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Minimal JSON-RPC client over child stdio
// ────────────────────────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: any
}

interface RpcIncomingRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: any
}

type RpcIncoming = RpcResponse | RpcNotification | RpcIncomingRequest

class AcpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private notificationHandlers = new Map<string, (params: any) => void>()
  private requestHandlers = new Map<
    string,
    (params: any) => Promise<unknown> | unknown
  >()
  private closed = false

  constructor(private child: ChildProcessWithoutNullStreams) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    ;(rl as unknown as EventEmitter).on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: RpcIncoming
      try {
        msg = JSON.parse(trimmed) as RpcIncoming
      } catch {
        // Non-JSON line (debug log etc.) — ignore.
        return
      }
      this.dispatch(msg)
    })

    child.stderr?.on('data', () => {
      // Discard CLI debug noise — surfaced via the agent's status notifications.
    })

    ;(child as unknown as EventEmitter).on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true
      const err = new Error(`gemini --acp exited (code=${code} signal=${signal})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }

  private dispatch(msg: RpcIncoming): void {
    if ('id' in msg && 'method' in msg) {
      // Server → client RPC request (e.g. session/request_permission).
      const handler = this.requestHandlers.get(msg.method)
      if (!handler) {
        this.write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        })
        return
      }
      Promise.resolve(handler(msg.params))
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((e) =>
          this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: e?.message ?? String(e) },
          }),
        )
      return
    }
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
      return
    }
    if ('method' in msg) {
      const handler = this.notificationHandlers.get(msg.method)
      if (handler) handler(msg.params)
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`)
    } catch {
      // Pipe broken — child exited mid-write. The 'exit' handler will
      // reject any pending promises.
    }
  }

  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: (params: any) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler)
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params } satisfies RpcRequest)
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params } satisfies RpcNotification)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.child.stdin.end()
    } catch { /* already closed */ }
    if (!this.child.killed) this.child.kill('SIGTERM')
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ACP → AgentEvent translation
// ────────────────────────────────────────────────────────────────────────────

function extractText(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  if (Array.isArray(content)) return content.map(extractText).join('')
  return ''
}

function translateUpdate(update: any): AgentEvent[] {
  const events: AgentEvent[] = []
  if (!update?.sessionUpdate) return events
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractText(update.content)
      if (text) events.push({ type: 'text', text })
      break
    }
    case 'agent_thought_chunk': {
      const text = extractText(update.content)
      if (text) events.push({ type: 'thinking', text })
      break
    }
    case 'tool_call':
      events.push({
        type: 'tool_start',
        toolId: String(update.toolCallId ?? ''),
        toolName: String(update.title ?? update.kind ?? ''),
        input: update.input ?? {},
      })
      break
    case 'tool_call_update': {
      const status = String(update.status ?? '')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        const resultText = Array.isArray(update.content)
          ? update.content.map((c: any) => extractText(c.content ?? c)).join('\n')
          : extractText(update.content)
        events.push({
          type: 'tool_end',
          toolId: String(update.toolCallId ?? ''),
          toolName: String(update.title ?? ''),
          result: resultText,
          isError: status === 'failed',
        })
      }
      break
    }
    // plan / mode / command updates: not surfaced — UI doesn't render them.
    default:
      break
  }
  return events
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

export function createGeminiAdapter(): AgentAdapter {
  return {
    agent: 'gemini',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const {
        prompt,
        sessionId,
        model,
        cwd,
        mcpServerUrl,
        permissionCallback,
        abortSignal,
        tabId,
      } = params

      const cliPath = find_gemini_cli()
      if (!cliPath) {
        yield {
          type: 'result',
          isError: true,
          errorMessage:
            'Gemini CLI not found on PATH. Install with: npm install -g @google/gemini-cli',
        }
        yield { type: 'done' }
        return
      }

      const args = ['--acp']
      if (model) args.push('--model', model)
      const child = spawn(cliPath, args, {
        cwd: cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // GEMINI_API_KEY required by the CLI; OAuth users have a real one
          // in their env, otherwise the CLI falls back to ~/.gemini/oauth_creds.json.
          GEMINI_API_KEY:
            process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || 'oauth',
        },
      })

      const client = new AcpClient(child)
      const eventQueue: AgentEvent[] = []
      let queueResolve: (() => void) | null = null
      let streamDone = false
      let stopReason: string | undefined
      const promptErrorBox: { value: Error | null } = { value: null }

      const pushEvent = (e: AgentEvent) => {
        eventQueue.push(e)
        if (queueResolve) {
          const r = queueResolve
          queueResolve = null
          r()
        }
      }

      client.onNotification('session/update', (notifParams: any) => {
        for (const ev of translateUpdate(notifParams?.update)) {
          pushEvent(ev)
        }
      })

      client.onRequest('session/request_permission', async (rpcParams: any) => {
        const tc = rpcParams?.toolCall ?? rpcParams ?? {}
        const result = await permissionCallback({
          id: String(tc.toolCallId ?? tc.id ?? ''),
          toolName: String(tc.title ?? tc.kind ?? tc.toolName ?? ''),
          input: tc.input ?? {},
        })
        // ACP `optionId` is a server-defined string (e.g. `proceed_once` or
        // `allow-once`, varies by agent). Pick from the `options` array the
        // agent sent with the request by matching `kind`. Falls back to the
        // first option of either category if the agent uses non-standard
        // kinds.
        const options: Array<{ optionId: string; kind?: string }> = Array.isArray(rpcParams?.options)
          ? rpcParams.options
          : []
        const wantKinds = result.behavior === 'allow'
          ? ['allow_once', 'allow_always']
          : ['reject_once', 'reject_always']
        const match = options.find((o) => wantKinds.includes(String(o.kind ?? '')))
        if (match) {
          return { outcome: { outcome: 'selected', optionId: match.optionId } }
        }
        // No kind match — fall back to first option (allow path) or last (deny).
        if (options.length > 0) {
          const fallback = result.behavior === 'allow' ? options[0] : options[options.length - 1]
          return { outcome: { outcome: 'selected', optionId: fallback.optionId } }
        }
        // No options at all — cancel the turn rather than hang.
        return { outcome: { outcome: 'cancelled' } }
      })

      // Forward an abort from the caller through cancel + child kill.
      const onAbort = () => {
        if (sessionId) client.notify('session/cancel', { sessionId })
        client.shutdown()
      }
      if (abortSignal) {
        if (abortSignal.aborted) onAbort()
        else abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        // 1. initialize
        await client.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'catgo-agent-bridge', title: 'CatGo', version: '1.0.2' },
        })

        // 2. session/new — carry the CatGo MCP server + tabId header so
        //    structure pushes from this gemini run land in the chat's
        //    active panel.
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

        // 3. session/prompt — fire-and-forget, drain notifications until result.
        const promptPromise = client
          .request<{ stopReason?: string }>('session/prompt', {
            sessionId: effectiveSessionId,
            prompt: [{ type: 'text', text: prompt }],
          })
          .then((res) => {
            stopReason = res?.stopReason
            streamDone = true
            if (queueResolve) {
              const r = queueResolve
              queueResolve = null
              r()
            }
          })
          .catch((e: Error) => {
            promptErrorBox.value = e
            streamDone = true
            if (queueResolve) {
              const r = queueResolve
              queueResolve = null
              r()
            }
          })

        // 4. Drain event queue until prompt resolves.
        while (!streamDone || eventQueue.length > 0) {
          if (eventQueue.length > 0) {
            yield eventQueue.shift()!
            continue
          }
          if (streamDone) break
          await new Promise<void>((resolve) => {
            queueResolve = resolve
          })
        }
        await promptPromise
      } finally {
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
        client.shutdown()
      }

      if (promptErrorBox.value) {
        yield { type: 'result', isError: true, errorMessage: promptErrorBox.value.message }
      } else {
        yield {
          type: 'result',
          isError: stopReason === 'refusal',
          errorMessage:
            stopReason === 'max_tokens'
              ? 'Reached model max_tokens'
              : stopReason === 'max_turn_requests'
              ? 'Reached max turn requests'
              : stopReason === 'refusal'
              ? 'Model refused to continue'
              : undefined,
        }
      }
      yield { type: 'done' }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // ACP exposes session/load but no session-list method yet.
      return []
    },
  }
}

registerAdapter('gemini', createGeminiAdapter)
