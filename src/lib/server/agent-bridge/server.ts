/**
 * Standalone HTTP server for the Agent SDK bridge.
 *
 * Background: in `pnpm desktop:dev` the `/api/agent/*` endpoints are served
 * by `vite-plugin-agent-bridge.ts` as middleware on the Vite dev server.
 * Production AppImage / .deb / .dmg builds have no Vite, so those routes
 * 404 and CatBot stalls when a user picks Claude Code / Codex / Gemini CLI.
 *
 * This module is the production substitute — a tiny Node-API HTTP server
 * (compiled via `bun build --compile` into a single binary) that Tauri
 * launches as a sidecar. The handler logic is intentionally identical to
 * the Vite middleware so the SDK adapters behave the same in dev and prod.
 *
 * Spawned by Rust in `src-tauri/src/lib.rs` (next to the Python sidecar).
 * Bound to 127.0.0.1 only — never expose this to the network, the SDK
 * adapters can spawn arbitrary CLIs on the host.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { createAdapter } from './adapter.js'
import { registerPending, resolvePending } from './permission-manager.js'
import type { AgentType } from './types.js'

// Eagerly import adapters so their `registerAdapter` side-effects run.
// In the bundled binary these all become one file, so no dynamic-import
// gymnastics needed.
import './adapters/claude.js'
import './adapters/codex.js'
import './adapters/gemini.js'
import { shutdownGeminiPool } from './adapters/gemini.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VALID_AGENTS = ['claude', 'codex', 'gemini'] as const

const AGENT_PORT = Number(process.env.CATGO_AGENT_PORT ?? 8001)
const BACKEND_PORT = Number(process.env.CATGO_BACKEND_PORT ?? 8000)
const HOST = '127.0.0.1'

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  // Tauri webview origin varies (tauri://localhost, http://tauri.localhost).
  // The sidecar only listens on 127.0.0.1 so wildcard CORS is fine.
  'Access-Control-Allow-Origin': '*',
}

const JSON_HEADER = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, JSON_HEADER)
  res.end(JSON.stringify(data))
}

function mcpUrlFor(): string {
  return process.env.CATGO_API
    ? `${process.env.CATGO_API.replace(/\/$/, '')}/mcp/`
    : `http://127.0.0.1:${BACKEND_PORT}/api/mcp/`
}

function agentCwdFor(agent: AgentType): string {
  const dir = join(homedir(), '.catgo', 'agents', agent)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req))
  const { agent, prompt, sessionId, model, systemPrompt, attachments, tabId, chatId } = body
  const skipPermissions = body.skipPermissions === true

  if (!VALID_AGENTS.includes(agent)) {
    jsonResponse(res, 400, { error: `Invalid agent: must be one of ${VALID_AGENTS.join(', ')}` })
    return
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    jsonResponse(res, 400, { error: 'prompt must be a non-empty string' })
    return
  }

  const adapter = createAdapter(agent as AgentType)
  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  res.writeHead(200, SSE_HEADERS)

  const writeEvent = (event: unknown): void => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const permissionCallback = async (permReq: any) => {
    writeEvent({
      type: 'permission_request',
      id: permReq.id,
      toolName: permReq.toolName,
      input: permReq.input,
      suggestions: permReq.suggestions,
      decisionReason: permReq.decisionReason,
    })
    return registerPending(permReq)
  }

  try {
    for await (const event of adapter.stream({
      prompt,
      sessionId,
      model,
      systemPrompt,
      cwd: agentCwdFor(agent as AgentType),
      mcpServerUrl: mcpUrlFor(),
      attachments,
      permissionCallback,
      abortSignal: abortController.signal,
      tabId,
      skipPermissions,
      chatId,
    })) {
      writeEvent(event)
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    writeEvent({ type: 'result', isError: true, errorMessage })
    writeEvent({ type: 'done' })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

async function handlePermission(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req))
  const { permissionId, behavior, suggestions, updatedInput } = body

  if (!permissionId || typeof permissionId !== 'string') {
    jsonResponse(res, 400, { error: 'permissionId is required' })
    return
  }
  if (!['allow', 'allow_session', 'deny'].includes(behavior)) {
    jsonResponse(res, 400, { error: 'behavior must be one of: allow, allow_session, deny' })
    return
  }

  const ok = resolvePending(permissionId, behavior, suggestions, updatedInput)
  jsonResponse(res, 200, { ok })
}

async function handleSessions(url: URL, res: ServerResponse): Promise<void> {
  const agent = url.searchParams.get('agent')
  if (!agent || !VALID_AGENTS.includes(agent as never)) {
    jsonResponse(res, 400, { error: `Invalid agent: must be one of ${VALID_AGENTS.join(', ')}` })
    return
  }
  const sessions = await createAdapter(agent as AgentType).listSessions()
  jsonResponse(res, 200, { sessions })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CatGo-Tab-Id',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    if (url.pathname === '/api/agent/stream' && req.method === 'POST') {
      await handleStream(req, res)
      return
    }
    if (url.pathname === '/api/agent/permission' && req.method === 'POST') {
      await handlePermission(req, res)
      return
    }
    if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
      await handleSessions(url, res)
      return
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      // `service` is an identity marker: the desktop shell probes /health and
      // only treats a port as "the agent already running" when it sees this,
      // so a foreign process squatting the port is not mistaken for us.
      jsonResponse(res, 200, { ok: true, service: 'catgo-agent', port: AGENT_PORT })
      return
    }

    jsonResponse(res, 404, { error: 'Not found' })
  } catch (err) {
    console.error('[catgo-agent] handler error:', err)
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: String(err) })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

server.listen(AGENT_PORT, HOST, () => {
  // Stdout line is read by the Rust sidecar host so it can log a clean
  // "agent server ready" line and confirm the port. Keep this stable.
  console.log(`[catgo-agent] listening on http://${HOST}:${AGENT_PORT}`)
})

// Graceful shutdown — Tauri sidecar sends SIGTERM on app exit.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Kill all persistent gemini --acp children so desktop:serve restarts
    // don't leak processes.
    void shutdownGeminiPool()
    server.close(() => process.exit(0))
    // Hard exit after 2s if close hangs (long-poll SSE connection)
    setTimeout(() => process.exit(1), 2000).unref()
  })
}
