import { query, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, PermissionRequest, SessionInfo, StreamParams } from '../types.js'

// ---------------------------------------------------------------------------
// Claude Code CLI discovery.
//
// The Agent SDK does NOT search $PATH — it expects `claude` at a vendored
// path under the SDK's own node_modules.  When users install Claude Code
// through Anthropic's installer it lands at `~/.local/bin/claude` (Linux/Mac)
// or somewhere else, and the SDK throws "Claude Code native binary not
// found" before even spawning the process.
//
// Resolve the CLI ourselves here and pass `pathToClaudeCodeExecutable` to
// the SDK so it skips its own (broken-for-our-case) lookup.  We cache the
// result so we only run `which` once per process.
//
// Windows gotcha: `npm i -g @anthropic-ai/claude-code` drops THREE wrappers
// in %APPDATA%\npm — `claude` (a /bin/sh shim), `claude.cmd`, `claude.ps1` —
// all of which exec the real 200MB native binary vendored at
// `<npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
// `where claude` returns the extensionless sh-shim first; handing THAT to the
// SDK makes it throw "Claude Code native binary not found" because it is not
// a real executable on Windows.  So whenever a resolved path is one of these
// npm wrappers, dereference it to the vendored native binary.
// ---------------------------------------------------------------------------

let _claudePath: string | null | undefined
let _claudeEnvLoaded = false

type ClaudeEnvMap = Record<string, string>

// Given any resolved `claude` path (possibly an npm `.cmd`/`.ps1`/sh shim),
// prefer the real vendored native binary the shim ultimately execs.
function nativeBinaryFor(p: string): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const vendored = join(
    dirname(p),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    exe,
  )
  return existsSync(vendored) ? vendored : p
}

function resolveClaudeExecutable(): string | undefined {
  if (_claudePath !== undefined) return _claudePath ?? undefined

  // 1. Explicit override
  const override = process.env.CATGO_CLAUDE_PATH
  if (override && existsSync(override)) {
    _claudePath = nativeBinaryFor(override)
    return _claudePath
  }

  // 2. PATH lookup via `which` / `where` (scan every line — on Windows the
  //    first is the unusable sh-shim; nativeBinaryFor() rescues it anyway).
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude'
    const lines = execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)
    for (const found of lines) {
      if (found && existsSync(found)) {
        _claudePath = nativeBinaryFor(found)
        return _claudePath
      }
    }
  } catch {
    // not on PATH
  }

  // 3. Common install locations
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
    join(homedir(), '.bun', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  if (process.platform === 'win32' && process.env.APPDATA) {
    // npm global prefix on Windows: %APPDATA%\npm
    candidates.unshift(
      join(
        process.env.APPDATA,
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
      join(process.env.APPDATA, 'npm', 'claude.cmd'),
    )
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      _claudePath = nativeBinaryFor(c)
      return _claudePath
    }
  }

  _claudePath = null
  return undefined
}

function readJsonEnv(file: string): ClaudeEnvMap {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const env = (parsed as { env?: unknown }).env
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
    const out: ClaudeEnvMap = {}
    for (const [key, value] of Object.entries(env)) {
      if (!key || typeof value !== 'string') continue
      out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function read_claude_settings_env(home: string = homedir()): ClaudeEnvMap {
  return {
    ...readJsonEnv(join(home, '.claude', 'settings.json')),
    ...readJsonEnv(join(home, '.claude', 'settings.local.json')),
  }
}

export function apply_claude_settings_env(
  target: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const env = read_claude_settings_env(home)
  const applied: string[] = []
  for (const [key, value] of Object.entries(env)) {
    // Keep explicit system/user environment variables authoritative. The
    // settings.json fallback only fills gaps for desktop sidecars launched
    // outside an interactive shell.
    if (target[key]) continue
    target[key] = value
    applied.push(key)
  }
  return applied
}

function ensureClaudeSettingsEnv(): void {
  if (_claudeEnvLoaded) return
  _claudeEnvLoaded = true
  const applied = apply_claude_settings_env()
  if (applied.length > 0) {
    console.info(`[agent-bridge] loaded Claude settings env: ${applied.join(', ')}`)
  }
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
// Text-loss guard: pure helper
// ---------------------------------------------------------------------------

/** When a turn's final `assistant` message carries text but NO partial deltas
 *  streamed for it (the classic cold-start first turn), return those text
 *  blocks as `text` events so the reply is not silently dropped. Returns `[]`
 *  when text already streamed (`streamedTextLen > 0`) to avoid duplicating it.
 *
 *  `translateMessage` deliberately skips the text blocks on the `assistant`
 *  message, assuming `stream_event` partials already delivered them — this is
 *  the safety net for the turns where they didn't (blank-bubble bug). */
export function assistant_text_fallback(
  assistantMsg: any,
  streamedTextLen: number,
): AgentEvent[] {
  if (streamedTextLen > 0) return []
  const content: any[] = (assistantMsg?.message as any)?.content ?? []
  const out: AgentEvent[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out
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

      ensureClaudeSettingsEnv()
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
        },
      })

      // Track streamed text per turn so a turn that emits NO partial deltas
      // (cold-start first turn) still surfaces its final text via the fallback
      // — otherwise the reply is silently dropped (blank bubble, then cleaned
      // up by chat-state, so the user sees "no reply" until a second send).
      let streamedTextLen = 0
      for await (const msg of q) {
        if (
          (msg as any).type === 'stream_event' &&
          (msg as any).event?.type === 'content_block_delta' &&
          (msg as any).event?.delta?.type === 'text_delta'
        ) {
          streamedTextLen += String((msg as any).event.delta.text ?? '').length
        }
        if ((msg as any).type === 'assistant') {
          for (const event of assistant_text_fallback(msg, streamedTextLen)) {
            yield event
          }
          streamedTextLen = 0 // turn boundary — reset for the next assistant turn
        }
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
