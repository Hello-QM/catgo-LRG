import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentAdapter } from '../adapter.js'
import { registerAdapter } from '../adapter.js'
import type { AgentEvent, SessionInfo, StreamParams } from '../types.js'
import {
  attachmentPathContext,
  materializeAttachments,
  type MaterializedAttachment,
} from '../attachments.js'

// ---------------------------------------------------------------------------
// Codex binary resolution.
//
// `@openai/codex-sdk` HARD-PINS an old `@openai/codex` as a dependency and its
// findCodexPath() runs THAT vendored copy — so `npm i -g @openai/codex@latest`
// has zero effect and newer models (e.g. gpt-5.6, which needs a codex newer
// than the SDK's pin) stay rejected with "requires a newer version of Codex".
// The SDK does expose `codexPathOverride`, which becomes the spawned
// executable verbatim (no shell), so point it at the globally-installed
// codex's NATIVE binary. Override with CATGO_CODEX_PATH.
//
// Cross-platform (Windows / macOS / Linux): locate the globally-installed
// `@openai/codex` package, then scan its bundled per-platform native package
// (`@openai/codex-<plat>/vendor/<target-triple>/codex/codex[.exe]`) for the
// real binary. The vendor target-triple varies (e.g. linux musl vs gnu,
// apple-darwin arm64/x64), so we scan the vendor dir rather than hard-code it.
// ---------------------------------------------------------------------------

/** Search PATH for the first existing entry among `names`. */
function findOnPath(names: string[]): string | undefined {
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir, n)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

/** Find a native `codex` binary inside an `@openai/codex` package root. */
function nativeBinaryUnder(codexRoot: string): string | undefined {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const scope = join(codexRoot, 'node_modules', '@openai')
  let plats: string[] = []
  try {
    plats = readdirSync(scope).filter((d) => d.startsWith('codex-'))
  } catch {
    return undefined
  }
  for (const plat of plats) {
    const vendor = join(scope, plat, 'vendor')
    let triples: string[] = []
    try {
      triples = readdirSync(vendor)
    } catch {
      continue
    }
    for (const triple of triples) {
      // The exe subdir varies by codex version: `bin/` (≥0.133),
      // `codex/` (≤0.130), or directly under the triple dir.
      for (const sub of ['bin', 'codex', '']) {
        const bin = join(vendor, triple, sub, exe)
        if (existsSync(bin)) return bin
      }
    }
  }
  return undefined
}

function resolveCodexExecutable(): string | undefined {
  const override = process.env.CATGO_CODEX_PATH
  if (override && existsSync(override)) return override

  // Candidate `@openai/codex` package roots: from the `codex` CLI on PATH
  // (its bin is `<root>/bin/codex.js`), and the legacy npm-global Windows path.
  const cliOnPath = findOnPath(
    process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'],
  )
  const roots: string[] = []
  if (cliOnPath) {
    try {
      // POSIX npm/pnpm: bin is a symlink → <root>/bin/codex.js → up 2 = root.
      roots.push(dirname(dirname(realpathSync(cliOnPath))))
    } catch {
      /* ignore */
    }
    // npm/pnpm-global layout (works on every OS, incl. Windows where the CLI
    // is a `codex.cmd` shim that realpath can't follow): the package sits at
    // <prefix>/node_modules/@openai/codex next to the CLI shim.
    roots.push(join(dirname(cliOnPath), 'node_modules', '@openai', 'codex'))
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    // Legacy npm-global on Windows nests under %APPDATA%\npm.
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'))
  }
  for (const root of roots) {
    const bin = nativeBinaryUnder(root)
    if (bin) return bin
  }

  // Last resort: spawn the CLI wrapper on PATH directly. Its shebang makes it
  // executable on macOS/Linux; on Windows a `.cmd` shim can't be spawned
  // without a shell, so this only helps Unix.
  if (cliOnPath && process.platform !== 'win32') return cliOnPath
  return undefined
}

// ---------------------------------------------------------------------------
// Helper: translate a single Codex SDK event to zero or more AgentEvents
// ---------------------------------------------------------------------------

// Per-thread incremental-text tracking. The Codex SDK emits item.updated with
// `item.text` containing the FULL accumulated text so far (not a delta), so
// the adapter has to diff against the last seen text per item to surface
// chunked output. State is keyed by `item.id` and cleared opportunistically
// on item.completed.
const _item_text_seen = new Map<string, string>()

// Never reuse the conventional `catgo` key for the desktop transport. A
// user's global Codex config commonly defines it as a stdio server connected
// to another CatGo checkout/database. Keep the user's other MCP servers, but
// disable that legacy CatGo entry inside CatBot so the model cannot silently
// create a workflow in the wrong application instance.
export const CODEX_CATGO_MCP_SERVER = `catgo_desktop`
const CODEX_LEGACY_CATGO_MCP_SERVER = `catgo`

export function buildCodexMcpConfig(
  mcpServerUrl: string,
  tabId?: string,
): Record<string, Record<string, unknown>> {
  const catgo: Record<string, unknown> = {
    url: mcpServerUrl,
    startup_timeout_sec: 20,
  }
  if (tabId) catgo.http_headers = { 'X-CatGo-Tab-Id': tabId }
  return {
    [CODEX_LEGACY_CATGO_MCP_SERVER]: { enabled: false },
    [CODEX_CATGO_MCP_SERVER]: catgo,
  }
}

/**
 * Build the child environment explicitly so shell helpers and user skills see
 * the same dynamic CatGo backend that the injected HTTP MCP transport uses.
 *
 * Desktop/worktree instances rarely run on the legacy :8000 default.  The SDK
 * otherwise inherits CATGO_BACKEND_PORT only when the parent happened to set
 * it, while generic CatGo instructions fall back to :33413 (an external
 * reverse-tunnel port).  CATGO_API is the canonical, unambiguous endpoint.
 */
export function buildCodexEnvironment(
  mcpServerUrl?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  )
  if (!mcpServerUrl) return env

  try {
    const url = new URL(mcpServerUrl)
    const apiPath = url.pathname.replace(/\/mcp\/?$/, ``).replace(/\/$/, ``)
    env.CATGO_API = `${url.origin}${apiPath}`
    if (url.port) env.CATGO_BACKEND_PORT = url.port
  } catch {
    // The MCP config will surface a malformed URL. Keep the inherited
    // environment intact instead of introducing a second adapter failure.
  }
  return env
}

export function buildCodexInput(
  prompt: string,
  attachments: MaterializedAttachment[],
): string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> {
  if (attachments.length === 0) return prompt
  const images = attachments.filter((attachment) => attachment.mimeType.startsWith('image/'))
  const files = attachments.filter((attachment) => !attachment.mimeType.startsWith('image/'))
  const pathContext = attachmentPathContext(files)
  const text = pathContext ? `${prompt}\n\n${pathContext}` : prompt
  return [
    { type: 'text', text },
    ...images.map((attachment) => ({
      type: 'local_image' as const,
      path: attachment.path,
    })),
  ]
}

function emit_text_delta(itemId: string, fullText: string): string | null {
  const prev = _item_text_seen.get(itemId) ?? ''
  if (!fullText || fullText === prev) return null
  const delta = fullText.startsWith(prev) ? fullText.slice(prev.length) : fullText
  _item_text_seen.set(itemId, fullText)
  return delta || null
}

export function* translateEvent(evt: any): Generator<AgentEvent> {
  const type: string = evt?.type ?? ''

  // Codex SDK ≥0.117 ThreadEvent union:
  //   thread.started | turn.started | turn.completed | turn.failed |
  //   item.started | item.updated | item.completed | error
  // Item payloads (evt.item.type):
  //   agent_message | reasoning | command_execution | file_change |
  //   mcp_tool_call | web_search | todo_list | error

  // ── thread.started ─────────────────────────────────────────────────────────
  if (type === 'thread.started') {
    yield { type: 'status', sessionId: evt.thread_id }
    return
  }

  // ── item.started / item.updated → text deltas + tool_start ────────────────
  if (type === 'item.started' || type === 'item.updated') {
    const item = evt.item ?? {}
    const item_type: string = item.type ?? ''
    const item_id: string = item.id ?? ''

    if (item_type === 'agent_message' || item_type === 'reasoning') {
      const delta = emit_text_delta(item_id, item.text ?? '')
      if (delta) yield { type: 'text', text: delta }
      return
    }
    if (type === 'item.started') {
      if (item_type === 'command_execution') {
        yield {
          type: 'tool_start',
          toolId: item_id,
          toolName: 'bash',
          input: { command: item.command ?? '' },
        }
        return
      }
      if (item_type === 'mcp_tool_call') {
        yield {
          type: 'tool_start',
          toolId: item_id,
          toolName: `${item.server ?? 'mcp'}.${item.tool ?? ''}`,
          input: item.arguments ?? {},
        }
        return
      }
    }
    return
  }

  // ── item.completed → flush trailing text, close tools ─────────────────────
  if (type === 'item.completed') {
    const item = evt.item ?? {}
    const item_type: string = item.type ?? ''
    const item_id: string = item.id ?? ''

    if (item_type === 'agent_message' || item_type === 'reasoning') {
      const delta = emit_text_delta(item_id, item.text ?? '')
      if (delta) yield { type: 'text', text: delta }
      _item_text_seen.delete(item_id)
      return
    }
    if (item_type === 'command_execution') {
      const isError = item.exit_code !== undefined && item.exit_code !== 0
      yield {
        type: 'tool_end',
        toolId: item_id,
        toolName: 'bash',
        result: item.aggregated_output ?? '',
        isError,
      }
      return
    }
    if (item_type === 'mcp_tool_call') {
      const isError = item.status === 'failed'
      const output = item.result?.content ?? item.error?.message ?? ''
      yield {
        type: 'tool_end',
        toolId: item_id,
        toolName: `${item.server ?? 'mcp'}.${item.tool ?? ''}`,
        result: typeof output === 'string' ? output : JSON.stringify(output),
        isError,
      }
      return
    }
    if (item_type === 'error') {
      // ErrorItem is non-fatal in the Codex SDK event model. Codex may emit
      // one for a recoverable discovery warning (for example the optional
      // skills-description budget), then continue with an agent message and
      // turn.completed. Only top-level error / turn.failed events below end a
      // CatBot stream.
      return
    }
    return
  }

  // ── turn.completed → emit result with usage ───────────────────────────────
  if (type === 'turn.completed') {
    const usage = evt.usage
    yield {
      type: 'result',
      isError: false,
      usage: usage
        ? {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cached_input_tokens,
          }
        : undefined,
    }
    return
  }

  // ── turn.failed / error → surface error ───────────────────────────────────
  if (type === 'turn.failed' || type === 'error') {
    const msg = evt.error?.message ?? evt.message ?? 'Unknown Codex error'
    yield { type: 'result', isError: true, errorMessage: msg }
    yield { type: 'done' }
    return
  }
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export function createCodexAdapter(): AgentAdapter {
  return {
    agent: 'codex',

    async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
      const {
        prompt,
        sessionId,
        model,
        cwd,
        abortSignal,
        mcpServerUrl,
        tabId,
        systemPrompt,
        attachments,
      } = params

      // Dynamic import — the package may not be installed everywhere.
      const { Codex } = (await import('@openai/codex-sdk')) as any

      // MCP: wire CatGO's backend MCP server so Codex gets the same `catgo_*`
      // tools Claude/Gemini do (this adapter previously dropped mcpServerUrl
      // entirely — Codex had NO CatGO tools). codex-sdk flattens `config`
      // into `--config mcp_servers.catgo_desktop.*` overrides; codex ≥0.132
      // speaks streamable-HTTP MCP from a `url` (+ `http_headers` for tab
      // routing).
      //
      // Keep the injected bridge in a CatBot-specific namespace. A user's
      // ~/.codex/config.toml may already define a STDIO server named `catgo`;
      // reusing that key makes Codex deep-merge this HTTP URL into the STDIO
      // table and fail with "url is not supported for stdio". The distinct
      // key avoids the collision while preserving the complete user config,
      // including plugins, ChemMate skills, and their MCP dependencies.
      //
      // dangerously_bypass_approvals_and_sandbox: codex-sdk's headless `exec`
      // wires NO approval responder, so EVERY tool call — including MCP — is
      // auto-cancelled ("user cancelled MCP tool call"). `approval_policy`
      // only gates shell commands, NOT MCP elicitation/request_permissions,
      // so 'never' alone didn't help. This flag disables all gating, the
      // codex equivalent of Claude/Gemini auto-allowing the trusted `catgo_*`
      // tools — required for ANY Codex tool-calling in this autonomous adapter
      // (a real approval↔PermissionCard bridge would be the longer-term fix).
      const codexConfig: Record<string, any> = {
        dangerously_bypass_approvals_and_sandbox: true,
      }
      // System prompt → codex `developer_instructions` config (codex-sdk has
      // no systemPrompt parameter, and exec mode's stdin is the user input).
      // Empirically verified to reach the model as a system instruction
      // (behavior fingerprint test, 2026-05-20). Without this the adapter
      // silently dropped systemPrompt — Codex never saw the loaded
      // structure / chat context that Claude got via `query({systemPrompt})`.
      if (systemPrompt) {
        codexConfig.developer_instructions = systemPrompt
      }
      if (mcpServerUrl) {
        codexConfig.mcp_servers = buildCodexMcpConfig(mcpServerUrl, tabId)
      }

      // codex-sdk turns the model into a `--model` CLI flag. When the UI sends
      // no model, omit the option so the installed Codex CLI selects its live
      // default. CATGO_CODEX_MODEL remains an explicit deployment override.
      //
      // IMPORTANT: runStreamed() reads the model from the *thread* options
      // (`this._threadOptions.model`), NOT the Codex() constructor — passing
      // it to `new Codex({model})` alone is silently ignored. It must go to
      // startThread()/resumeThread().
      const resolvedModel = model || process.env.CATGO_CODEX_MODEL || undefined

      const codexExe = resolveCodexExecutable()
      const codex = new Codex({
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(codexExe ? { codexPathOverride: codexExe } : {}),
        env: buildCodexEnvironment(mcpServerUrl),
        config: codexConfig,
      }) as any

      const threadOptions = resolvedModel ? { model: resolvedModel } : {}
      const thread = sessionId
        ? (codex.resumeThread(sessionId, threadOptions) as any)
        : (codex.startThread(threadOptions) as any)

      const abortController = new AbortController()
      if (abortSignal) {
        abortSignal.addEventListener('abort', () =>
          abortController.abort(abortSignal.reason),
        )
      }

      // SDK ≥ 0.117 returns `Promise<StreamedTurn>` where the event stream
      // lives on `.events` (AsyncGenerator<ThreadEvent>). Previously the call
      // was treated as if it already returned the iterable, producing
      // "streamIterable is not async iterable".
      // approvalPolicy: this adapter wires NO interactive approval responder,
      // so 'on-request' makes codex auto-CANCEL every tool call ("user
      // cancelled MCP tool call") — Codex couldn't run a single CatGO tool.
      // Claude/Gemini effectively auto-allow the trusted `catgo_*` MCP tools;
      // 'never' is the codex equivalent (run tools without prompting) and is
      // the only way Codex tool-calling works until a real approval↔
      // PermissionCard bridge exists for this adapter.
      const materialized = materializeAttachments(attachments, cwd ?? process.cwd())
      try {
        const streamedTurn = await thread.runStreamed(
          buildCodexInput(prompt, materialized.entries),
          {
            abortController,
            cwd: cwd ?? undefined,
            approvalPolicy: 'never',
          },
        )
        const streamIterable = streamedTurn.events as AsyncIterable<any>

        let resultEmitted = false

        for await (const evt of streamIterable) {
          for (const agentEvent of translateEvent(evt)) {
            yield agentEvent
            if (agentEvent.type === 'done') resultEmitted = true
          }
        }

        // Ensure we always close the stream with a result + done pair even if
        // the SDK didn't emit a terminal event.
        if (!resultEmitted) {
          yield { type: 'result', isError: false }
          yield { type: 'done' }
        }
      } finally {
        materialized.cleanup()
      }
    },

    async listSessions(): Promise<SessionInfo[]> {
      // The Codex SDK does not expose a session listing API at this time.
      return []
    },
  }
}

// Self-register at module load time.
registerAdapter('codex', createCodexAdapter)
