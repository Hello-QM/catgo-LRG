import { query, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, PermissionRequest, SessionInfo, StreamParams } from '../types.js'

// ---------------------------------------------------------------------------
// Claude Code CLI discovery.
//
// The Agent SDK runs `pathToClaudeCodeExecutable` *through a JS runtime*
// (`spawn(node|bun, [<path>, ...args])` — see sdk.mjs). So that path MUST be
// the Claude Code `cli.js` JavaScript entrypoint, NOT a platform shim:
//   - On Windows the `claude` shims are `claude.cmd` / `claude.ps1`. Node
//     refuses to spawn a `.cmd` without `shell:true` (CVE-2024-27980 →
//     EINVAL), and `node claude.cmd` is nonsense anyway, so handing the SDK
//     a shim makes `query()` fail/hang with no useful error.
// If we resolve nothing the SDK falls back to its own vendored cli.js, which
// is also fine — so returning undefined is a safe last resort.
//
// We locate the npm-global package's cli.js (the robust cross-platform
// anchor is `npm root -g`), with shim-directory derivation as a fallback.
// Cached so the lookup runs once per process.
// ---------------------------------------------------------------------------

const PKG_REL = join('@anthropic-ai', 'claude-code', 'cli.js')

let _claudePath: string | null | undefined

// Given a directory that may be an npm prefix / global node_modules / bin
// dir, return the package cli.js inside it if present.
function cliJsUnder(dir: string): string | undefined {
  const candidates = [
    join(dir, PKG_REL), // dir == global node_modules root
    join(dir, 'node_modules', PKG_REL), // dir == npm prefix (Windows global)
    join(dir, 'lib', 'node_modules', PKG_REL), // POSIX npm prefix
    join(dir, '..', 'lib', 'node_modules', PKG_REL), // dir == <prefix>/bin
  ]
  return candidates.find((c) => existsSync(c))
}

function resolveClaudeExecutable(): string | undefined {
  if (_claudePath !== undefined) return _claudePath ?? undefined

  const accept = (p: string | undefined): string | undefined => {
    if (p && existsSync(p)) {
      _claudePath = p
      return p
    }
    return undefined
  }

  // 1. Explicit override. If it points at a shim, still try to map it to the
  //    real cli.js the SDK needs; otherwise honour it verbatim.
  const override = process.env.CATGO_CLAUDE_PATH
  if (override && existsSync(override)) {
    if (override.endsWith('.js')) return accept(override)
    const fromOverride = cliJsUnder(join(override, '..'))
    return accept(fromOverride) ?? accept(override)
  }

  const isWin = process.platform === 'win32'
  const home = homedir()

  // 2. Primary: `npm root -g` → <globalNodeModules>/@anthropic-ai/claude-code/cli.js.
  //    Cross-platform and honours a customised `npm config set prefix`
  //    (common on locked-down lab/corp machines).
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (root) {
      const hit = accept(join(root, PKG_REL))
      if (hit) return hit
    }
  } catch {
    // npm unavailable — fall through to shim discovery
  }

  // Resolve the npm prefix too (shim location differs from node_modules root).
  let npmPrefix: string | undefined
  try {
    npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // ignore
  }
  const npmDefault = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const localDir = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')

  // Directories well-known installers drop the `claude` shim into. Used both
  // to augment PATH before `where`/`which` (the bridge often inherits a PATH
  // stripped of these, e.g. as a Tauri sidecar) and to probe directly.
  const binDirs = isWin
    ? [join(npmDefault, 'npm'), npmPrefix, join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(localDir, 'Programs', 'claude')]
    : [
        join(home, '.local', 'bin'),
        join(home, '.npm-global', 'bin'),
        join(home, '.bun', 'bin'),
        npmPrefix ? join(npmPrefix, 'bin') : undefined,
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ]
  const dirs = binDirs.filter((d): d is string => Boolean(d))

  // 3. Locate a shim via PATH-augmented `where`/`which`, then derive its
  //    package cli.js. (`where` can return a .cmd/.ps1 — never spawnable.)
  let shimDir: string | undefined
  try {
    const sep = isWin ? ';' : ':'
    const env = { ...process.env, PATH: [process.env.PATH, ...dirs].filter(Boolean).join(sep) }
    const found = execSync(isWin ? 'where claude' : 'which claude', { encoding: 'utf8', env })
      .trim()
      .split(/\r?\n/)[0]
    if (found && existsSync(found)) {
      if (found.endsWith('.js')) return accept(found)
      shimDir = join(found, '..')
    }
  } catch {
    // not on PATH
  }

  // 4. Probe known dirs (and any discovered shim dir) for the package cli.js.
  for (const d of [shimDir, ...dirs].filter((x): x is string => Boolean(x))) {
    const hit = accept(cliJsUnder(d))
    if (hit) return hit
  }

  // 5. Nothing resolved — let the SDK fall back to its own vendored cli.js.
  _claudePath = null
  return undefined
}

// ---------------------------------------------------------------------------
// Helper: translate a single SDK message to zero or more AgentEvents
// ---------------------------------------------------------------------------

function* translateMessage(msg: any): Generator<AgentEvent> {
  const type: string = msg.type

  // ── assistant ──────────────────────────────────────────────────────────────
  // Text/thinking are already streamed via stream_event (content_block_delta),
  // so only extract tool_use blocks here to avoid duplicate text.
  if (type === 'assistant') {
    const content: any[] = (msg.message as any)?.content ?? []
    for (const block of content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_start',
          toolId: (block.id ?? '') as string,
          toolName: (block.name ?? '') as string,
          input: block.input ?? {},
        }
      }
    }
    return
  }

  // ── stream_event (SDKPartialAssistantMessage) ──────────────────────────────
  if (type === 'stream_event') {
    const event: any = msg.event
    if (event?.type === 'content_block_delta') {
      const delta: any = event.delta
      if (delta?.type === 'text_delta') {
        yield { type: 'text', text: delta.text as string }
      } else if (delta?.type === 'thinking_delta') {
        yield { type: 'thinking', text: delta.thinking as string }
      }
    }
    return
  }

  // ── tool_progress ──────────────────────────────────────────────────────────
  if (type === 'tool_progress') {
    yield {
      type: 'tool_progress',
      toolId: msg.tool_use_id as string,
      toolName: msg.tool_name as string,
      elapsedSeconds: msg.elapsed_time_seconds as number,
    }
    return
  }

  // ── tool_use_summary ───────────────────────────────────────────────────────
  if (type === 'tool_use_summary') {
    // Mark preceding tools as complete
    const ids: string[] = msg.preceding_tool_use_ids ?? []
    for (const id of ids) {
      yield {
        type: 'tool_end',
        toolId: id,
        toolName: '',
        result: msg.summary as string,
        isError: false,
      }
    }
    yield { type: 'text', text: msg.summary as string }
    return
  }

  // ── result ─────────────────────────────────────────────────────────────────
  if (type === 'result') {
    const usage = msg.usage
    yield {
      type: 'result',
      isError: !!(msg.is_error),
      costUsd: msg.total_cost_usd as number | undefined,
      durationMs: msg.duration_ms as number | undefined,
      usage: usage
        ? {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cost_usd: msg.total_cost_usd,
          }
        : undefined,
    }
    yield {
      type: 'status',
      sessionId: msg.session_id as string | undefined,
    }
    return
  }

  // All other message types are silently ignored.
}

// ---------------------------------------------------------------------------
// Security gate: pure permission decision helper
// ---------------------------------------------------------------------------

/** Pure pre-decision for canUseTool. 'allow' = auto-allow without the
 *  PermissionCard; 'gate' = fall through to the human permissionCallback.
 *  Security-critical: CatGo MCP tools are always safe; skipPermissions
 *  only widens that when the user explicitly opted in (strict === true). */
export function decide_tool_permission(
  toolName: string,
  skipPermissions: boolean | undefined,
): 'allow' | 'gate' {
  if (toolName.startsWith('mcp__catgo__') || toolName.startsWith('catgo_')) return 'allow'
  if (skipPermissions === true) return 'allow'
  return 'gate'
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

export function createClaudeAdapter(): AgentAdapter {
  return {
    agent: 'claude',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const {
        prompt,
        sessionId,
        model,
        systemPrompt,
        cwd,
        mcpServerUrl,
        permissionCallback,
        abortSignal,
        tabId,
        skipPermissions,
      } = params

      const effectiveController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => effectiveController.abort(abortSignal.reason))
      }

      const mcpServers: Record<string, any> = {}
      if (mcpServerUrl) {
        // When tabId is provided, attach an X-CatGo-Tab-Id header so the
        // backend MCP ASGI wrapper (server/catgo/routers/mcp_http.py) can
        // bind it to the current_panel_id ContextVar — that's what makes
        // MCP structure pushes land in the originating tab's viewer
        // instead of the shared "default" panel.
        const catgoConfig: any = { type: 'http', url: mcpServerUrl }
        if (tabId) catgoConfig.headers = { 'X-CatGo-Tab-Id': tabId }
        mcpServers['catgo'] = catgoConfig
      }

      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: {
          signal: AbortSignal
          suggestions?: unknown[]
          blockedPath?: string
          decisionReason?: string
          toolUseID: string
          agentID?: string
        },
      ): Promise<any> => {
        // Auto-allow CatGo MCP tools and session-scoped skip-permission opt-out.
        // decide_tool_permission is the single source of truth for this gate.
        if (decide_tool_permission(toolName, skipPermissions) === 'allow') {
          return { behavior: 'allow' }
        }

        // Show PermissionCard to user and wait for their decision
        const req: PermissionRequest = {
          id: options.toolUseID,
          toolName,
          input,
          suggestions: options.suggestions,
          decisionReason: options.decisionReason,
        }

        const result = await permissionCallback(req)

        if (result.behavior === 'allow') {
          // If SDK provided suggestions, pass them through.
          // Otherwise, construct a session-scoped rule so "Allow Session"
          // actually prevents future prompts for this tool.
          const updatedPermissions = result.updatedPermissions
            ?? (options.suggestions && options.suggestions.length > 0
              ? options.suggestions
              : [{
                  type: 'addRules',
                  rules: [{ toolName }],
                  behavior: 'allow',
                  destination: 'session',
                }])

          // For AskUserQuestion the host injects the user's selected
          // answers as updatedInput ({ questions, answers }); the Agent
          // SDK turns it into the tool_result automatically. For ordinary
          // tools updatedInput is undefined and the call is just gated.
          return {
            behavior: 'allow',
            updatedPermissions,
            ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
          }
        } else {
          return {
            behavior: 'deny',
            message: result.message ?? 'Denied by user',
          }
        }
      }

      const claudeExe = resolveClaudeExecutable()

      const q = query({
        prompt,
        options: {
          abortController: effectiveController,
          cwd: cwd ?? undefined,
          model: model ?? undefined,
          systemPrompt: systemPrompt ?? undefined,
          resume: sessionId ?? undefined,
          includePartialMessages: true,
          mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
          permissionMode: 'default',
          allowedTools: ['mcp__catgo__*'],
          canUseTool,
          // Don't load global settings — prevents loading ~/.claude/mcp.json
          // stdio catgo server (we provide HTTP-mode catgo MCP above) and
          // disables sandbox (unnecessary — tools go through HTTP to backend).
          settingSources: [],
          // Point SDK at the user's Claude Code install — without this it
          // throws "Claude Code native binary not found" because it only
          // checks its own vendored path.
          ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
          // The bridge runs under bun (`bun run server.ts`), so the SDK
          // defaults `executable` to "bun" and spawns the Claude cli.js as
          // `bun cli.js`. On Windows that child's stdio pipe deadlocks and
          // query() hangs forever (the exact same call under node returns in
          // ~3s). Force "node" on Windows; POSIX is left at the SDK default.
          ...(process.platform === 'win32' ? { executable: 'node' as const } : {}),
        },
      })

      for await (const msg of q) {
        for (const event of translateMessage(msg)) {
          yield event
        }
      }

      yield { type: 'done' }
    },

    async listSessions(): Promise<SessionInfo[]> {
      const sdkSessions = await sdkListSessions()
      return sdkSessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        cwd: s.cwd,
      }))
    },
  }
}

// Self-register at module load time.
registerAdapter('claude', createClaudeAdapter)
