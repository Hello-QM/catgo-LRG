/**
 * Minimal Agent Client Protocol (ACP) JSON-RPC client over a child process'
 * stdio, plus the `gemini --acp` spawn + `initialize` handshake.
 *
 * Extracted from the one-shot Gemini adapter so the persistent process pool
 * (`process-pool.ts`) and the adapter glue (`adapters/gemini.ts`) can share
 * one implementation. ACP is the official IPC mode Gemini CLI 0.41+ exposes
 * for IDE / SDK embedding: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

// ────────────────────────────────────────────────────────────────────────────
// CLI lookup
// ────────────────────────────────────────────────────────────────────────────

let _gemini_cli_path: string | null | undefined
export function find_gemini_cli(): string | null {
  // Explicit override (also the test seam — points at a fake ACP CLI).
  // Bypasses the cache so tests can swap it between runs.
  const override = process.env.CATGO_GEMINI_PATH
  if (override) return override
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
// JSON-RPC wire types
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

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export class AcpClient {
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

  /** True once the child has exited or shutdown() was called. */
  get isClosed(): boolean {
    return this.closed
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
    if (this.closed) {
      return Promise.reject(new Error('gemini --acp client is closed'))
    }
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
// Spawn + handshake
// ────────────────────────────────────────────────────────────────────────────

export class GeminiCliNotFoundError extends Error {
  constructor() {
    super('Gemini CLI not found on PATH. Install with: npm install -g @google/gemini-cli')
    this.name = 'GeminiCliNotFoundError'
  }
}

export interface SpawnedAcp {
  child: ChildProcessWithoutNullStreams
  client: AcpClient
}

/**
 * Spawn `gemini --acp`, attach an {@link AcpClient}, and run the protocol
 * `initialize` handshake. Throws {@link GeminiCliNotFoundError} if the CLI
 * is not on PATH. The caller still owns `session/new` + `session/prompt`.
 */
export async function spawn_gemini_acp(opts: {
  cwd?: string
  model?: string
}): Promise<SpawnedAcp> {
  const cliPath = find_gemini_cli()
  if (!cliPath) throw new GeminiCliNotFoundError()

  const args = ['--acp']
  if (opts.model) args.push('--model', opts.model)

  const child = spawn(cliPath, args, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // GEMINI_API_KEY required by the CLI; OAuth users have a real one in
      // their env, otherwise the CLI falls back to ~/.gemini/oauth_creds.json.
      GEMINI_API_KEY:
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || 'oauth',
    },
  }) as ChildProcessWithoutNullStreams

  const client = new AcpClient(child)

  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'catgo-agent-bridge', title: 'CatGo', version: '1.0.2' },
  })

  return { child, client }
}
