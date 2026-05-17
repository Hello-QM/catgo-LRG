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
// The Agent SDK does NOT search $PATH — it expects `claude` at a vendored
// path under the SDK's own node_modules.  When users install Claude Code
// through Anthropic's installer it lands at `~/.local/bin/claude` (Linux/Mac)
// or somewhere else, and the SDK throws "Claude Code native binary not
// found" before even spawning the process.
//
// Resolve the CLI ourselves here and pass `pathToClaudeCodeExecutable` to
// the SDK so it skips its own (broken-for-our-case) lookup.  We cache the
// result so we only run `which` once per process.
// ---------------------------------------------------------------------------

let _claudePath: string | null | undefined

function resolveClaudeExecutable(): string | undefined {
  if (_claudePath !== undefined) return _claudePath ?? undefined

  // 1. Explicit override
  const override = process.env.CATGO_CLAUDE_PATH
  if (override && existsSync(override)) {
    _claudePath = override
    return override
  }

  // 2. PATH lookup via `which` / `where`
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude'
    const found = execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    if (found && existsSync(found)) {
      _claudePath = found
      return found
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
  for (const c of candidates) {
    if (existsSync(c)) {
      _claudePath = c
      return c
    }
  }

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
        // Auto-allow all CatGo MCP tools — they are safe backend operations
        if (toolName.startsWith('mcp__catgo__') || toolName.startsWith('catgo_')) {
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
