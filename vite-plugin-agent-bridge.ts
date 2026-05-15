/**
 * Vite plugin: agent-bridge middleware for desktop mode.
 *
 * In SvelteKit mode the `/api/agent/*` endpoints are served by server routes
 * under `src/routes/api/agent/`. Desktop mode uses standalone Vite (no
 * SvelteKit), so those routes don't exist. This plugin registers equivalent
 * middleware on the Vite dev server so the frontend can talk to the Agent SDK
 * adapters without change.
 *
 * Endpoints:
 *   POST /api/agent/stream      — SSE streaming (same logic as SvelteKit route)
 *   POST /api/agent/permission   — Resolve a pending permission request
 *   GET  /api/agent/sessions     — List sessions for an agent
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

const JSON_HEADER: Record<string, string> = {
  'Content-Type': 'application/json',
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, JSON_HEADER)
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// Lazy singleton: adapters are loaded once on first request so we don't pull
// in heavy SDK deps at plugin-load time (which would also cause circular-dep
// issues with the adapter self-registration pattern).
// ---------------------------------------------------------------------------

const VALID_AGENTS = ['claude', 'codex', 'gemini'] as const

let adaptersLoaded = false

async function ensureAdapters(): Promise<void> {
  if (adaptersLoaded) return
  // Dynamic imports trigger self-registration via registerAdapter().
  await import('./src/lib/server/agent-bridge/adapters/claude.js')
  await import('./src/lib/server/agent-bridge/adapters/codex.js')
  await import('./src/lib/server/agent-bridge/adapters/gemini.js')
  adaptersLoaded = true
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function agentBridgePlugin(serverPort: number): Plugin {
  return {
    name: 'vite-plugin-agent-bridge',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url!, 'http://localhost')

        // ── POST /api/agent/stream ────────────────────────────────────────
        if (url.pathname === '/api/agent/stream' && req.method === 'POST') {
          try {
            await ensureAdapters()

            const body = JSON.parse(await readBody(req))
            const { agent, prompt, sessionId, model, systemPrompt, attachments, tabId, chatId } = body

            if (!VALID_AGENTS.includes(agent)) {
              jsonResponse(res, 400, { error: `Invalid agent: must be one of ${VALID_AGENTS.join(', ')}` })
              return
            }
            if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
              jsonResponse(res, 400, { error: 'prompt must be a non-empty string' })
              return
            }

            const mcpServerUrl = process.env.CATGO_API
              ? `${process.env.CATGO_API.replace(/\/$/, '')}/mcp/`
              : `http://localhost:${serverPort}/api/mcp/`

            // Default working directory: ~/.catgo/agents/{agent}/
            // Keeps agent file operations isolated from source code
            const { homedir } = await import('node:os')
            const { mkdirSync, existsSync } = await import('node:fs')
            const { join } = await import('node:path')
            const agentCwd = join(homedir(), '.catgo', 'agents', agent)
            if (!existsSync(agentCwd)) mkdirSync(agentCwd, { recursive: true })

            const { createAdapter } = await import('./src/lib/server/agent-bridge/adapter.js')
            const { registerPending } = await import('./src/lib/server/agent-bridge/permission-manager.js')

            const adapter = createAdapter(agent as any)

            // Abort controller linked to client disconnect
            const abortController = new AbortController()
            req.on('close', () => abortController.abort())

            res.writeHead(200, SSE_HEADERS)

            const writeEvent = (event: unknown): void => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(event)}\n\n`)
              }
            }

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
                cwd: agentCwd,
                mcpServerUrl,
                attachments,
                permissionCallback,
                abortSignal: abortController.signal,
                tabId,
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
          } catch (err) {
            console.error('[agent-bridge] stream error:', err)
            if (!res.headersSent) {
              jsonResponse(res, 500, { error: String(err) })
            } else if (!res.writableEnded) {
              res.end()
            }
          }
          return
        }

        // ── POST /api/agent/permission ────────────────────────────────────
        if (url.pathname === '/api/agent/permission' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req))
            const { permissionId, behavior, suggestions } = body

            if (!permissionId || typeof permissionId !== 'string') {
              jsonResponse(res, 400, { error: 'permissionId is required' })
              return
            }
            if (!behavior || !['allow', 'allow_session', 'deny'].includes(behavior)) {
              jsonResponse(res, 400, { error: 'behavior must be one of: allow, allow_session, deny' })
              return
            }

            const { resolvePending } = await import('./src/lib/server/agent-bridge/permission-manager.js')
            const ok = resolvePending(permissionId, behavior, suggestions)

            jsonResponse(res, 200, { ok })
          } catch (err) {
            console.error('[agent-bridge] permission error:', err)
            jsonResponse(res, 500, { error: String(err) })
          }
          return
        }

        // ── GET /api/agent/sessions ───────────────────────────────────────
        if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
          try {
            await ensureAdapters()

            const agent = url.searchParams.get('agent')
            if (!agent || !VALID_AGENTS.includes(agent as any)) {
              jsonResponse(res, 400, { error: `Invalid agent: must be one of ${VALID_AGENTS.join(', ')}` })
              return
            }

            const { createAdapter } = await import('./src/lib/server/agent-bridge/adapter.js')
            const sessions = await createAdapter(agent as any).listSessions()

            jsonResponse(res, 200, { sessions })
          } catch (err) {
            console.error('[agent-bridge] sessions error:', err)
            jsonResponse(res, 500, { error: `Failed to list sessions: ${err instanceof Error ? err.message : err}` })
          }
          return
        }

        next()
      })
    },
  }
}
