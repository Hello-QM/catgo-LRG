/**
 * Persistent `gemini --acp` process pool — one long-lived process + ACP
 * session per chat tab, so Gemini remembers prior turns (matching the
 * Claude / Codex adapters, whose official SDKs already keep a subprocess
 * alive across turns).
 *
 * Lifecycle:
 *   • First acquire(chatId)  → spawn, `initialize`, `session/new`, store.
 *   • Repeat acquire(chatId) → same handle, same ACP sessionId reused.
 *   • Acquisitions for one chatId are serialized FIFO (one prompt in flight
 *     per tab) via a per-chat promise chain — the section is held until
 *     release(handle).
 *   • Idle > idleMs        → swept + killed.
 *   • Child crash          → entry dropped, chatId flagged; the next acquire
 *     respawns and sets `crashedBefore` so the adapter can surface a
 *     one-line "context reset" notice.
 *
 * The pool is the sole owner of every ManagedAcpProcess; direct refs (no
 * WeakRef) — eviction is explicit.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { AcpClient, spawn_gemini_acp } from './client.js'
import { mapPermissionRequest, type PermissionOutcome } from './translate.js'

export interface PoolInit {
  cwd?: string
  mcpServerUrl?: string
  /** Per-tab id → X-CatGo-Tab-Id header on the session's MCP server. */
  tabId?: string
  model?: string
}

export interface ManagedAcpProcess {
  chatId: string
  client: AcpClient
  sessionId: string
  child: ChildProcessWithoutNullStreams
  lastActivityMs: number
  busy: boolean
  /**
   * True when this process was respawned after the previous one for the
   * same chatId exited unexpectedly — the adapter shows a context-reset
   * banner exactly once, then clears it.
   */
  crashedBefore: boolean
  /**
   * Swapped by the adapter before each `stream()` so the long-lived
   * client's notifications/permission requests reach the live consumer.
   */
  onNotification: ((params: any) => void) | null
  onPermission: (params: any) => Promise<PermissionOutcome>
  /** @internal release the per-chat FIFO section. */
  _release?: () => void
  /** @internal set when the pool kills the process on purpose. */
  _intentionalStop?: boolean
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_SWEEP_MS = 15 * 1000

function defaultPermissionHandler(): Promise<PermissionOutcome> {
  // No adapter attached yet — cancel rather than hang the agent's turn.
  return Promise.resolve({ outcome: { outcome: 'cancelled' } })
}

export class GeminiProcessPool {
  private map = new Map<string, ManagedAcpProcess>()
  private chains = new Map<string, Promise<void>>()
  private crashed = new Set<string>()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false

  constructor(
    private idleMs: number = DEFAULT_IDLE_MS,
    private sweepMs: number = DEFAULT_SWEEP_MS,
  ) {}

  private ensureSweeper(): void {
    if (this.sweeper || this.shuttingDown) return
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs)
    // Don't keep the event loop alive just for the sweeper.
    this.sweeper.unref?.()
  }

  private sweep(): void {
    const now = Date.now()
    for (const [chatId, entry] of this.map) {
      if (!entry.busy && now - entry.lastActivityMs > this.idleMs) {
        this.drop(chatId, 'idle')
      }
    }
  }

  /**
   * Get the process for `chatId`, spawning + ACP-initializing one if none
   * exists or the previous one died. Blocks (FIFO) while another prompt for
   * the same chatId is in flight. Caller MUST call {@link release} when its
   * `session/prompt` settles.
   */
  async acquire(chatId: string, init: PoolInit): Promise<ManagedAcpProcess> {
    if (this.shuttingDown) throw new Error('GeminiProcessPool is shutting down')
    this.ensureSweeper()

    const prev = this.chains.get(chatId) ?? Promise.resolve()
    let releaseSection!: () => void
    const mine = new Promise<void>((r) => { releaseSection = r })
    // The chain advances only once this section is released.
    this.chains.set(chatId, prev.then(() => mine))

    await prev // wait our turn — FIFO across concurrent acquires

    try {
      let entry = this.map.get(chatId)
      if (!entry || entry.client.isClosed) {
        if (entry) this.map.delete(chatId)
        entry = await this.spawn(chatId, init)
        this.map.set(chatId, entry)
      }
      entry.busy = true
      entry.lastActivityMs = Date.now()
      entry._release = releaseSection
      return entry
    } catch (e) {
      // Spawn failed — free the section so we don't wedge the chain.
      releaseSection()
      throw e
    }
  }

  /** End the in-flight section; keeps the process alive for the next turn. */
  release(handle: ManagedAcpProcess): void {
    handle.busy = false
    handle.lastActivityMs = Date.now()
    handle.onNotification = null
    const r = handle._release
    handle._release = undefined
    if (r) r()
  }

  /** Kill + forget the process for `chatId` (idle sweep or explicit). */
  drop(chatId: string, _reason: string): void {
    const entry = this.map.get(chatId)
    if (!entry) return
    entry._intentionalStop = true
    this.map.delete(chatId)
    entry.client.shutdown()
    const r = entry._release
    entry._release = undefined
    if (r) r()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const entry of this.map.values()) {
      entry._intentionalStop = true
      entry.client.shutdown()
      const r = entry._release
      entry._release = undefined
      if (r) r()
    }
    this.map.clear()
    this.chains.clear()
  }

  /** Test/diagnostic: number of live processes. */
  get size(): number {
    return this.map.size
  }

  private async spawn(chatId: string, init: PoolInit): Promise<ManagedAcpProcess> {
    const { child, client } = await spawn_gemini_acp({ cwd: init.cwd, model: init.model })

    const mcpServers: any[] = []
    if (init.mcpServerUrl) {
      const headers: { name: string; value: string }[] = []
      if (init.tabId) headers.push({ name: 'X-CatGo-Tab-Id', value: init.tabId })
      mcpServers.push({ type: 'http', name: 'catgo', url: init.mcpServerUrl, headers })
    }
    const newSession = await client.request<{ sessionId: string }>('session/new', {
      cwd: init.cwd ?? process.cwd(),
      mcpServers,
    })

    const handle: ManagedAcpProcess = {
      chatId,
      client,
      sessionId: newSession?.sessionId ?? '',
      child,
      lastActivityMs: Date.now(),
      busy: false,
      crashedBefore: this.crashed.delete(chatId),
      onNotification: null,
      onPermission: defaultPermissionHandler,
    }

    // Long-lived handlers delegate to whatever the current stream installed.
    client.onNotification('session/update', (p: any) => {
      handle.onNotification?.(p)
    })
    client.onRequest('session/request_permission', (p: any) => handle.onPermission(p))

    ;(child as unknown as EventEmitter).on('exit', () => {
      // Only an *unexpected* exit flags a crash. Pool-initiated kills
      // (idle/shutdown) set _intentionalStop first.
      if (this.map.get(chatId) === handle && !handle._intentionalStop) {
        this.crashed.add(chatId)
        this.map.delete(chatId)
        const r = handle._release
        handle._release = undefined
        if (r) r()
      }
    })

    return handle
  }
}

/** Re-export so the adapter has one import site for the mapping helper. */
export { mapPermissionRequest }
