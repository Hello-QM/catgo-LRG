/**
 * CatBot tools that read/operate the visible terminal pane. Each `run` resolves
 * the active terminal handle (auto-spawning a local one if none) and calls into
 * it. Registered into CLIENT_TOOLS by structure-tools.ts. Mutating tools are
 * gated by the existing PermissionCard flow (kind: 'mutate').
 */
import type { ClientTool, ToolExecutionContext } from './types'
import { ensure_active_terminal } from '../structure/terminal-registry.svelte'
import { resolve_keys } from '../structure/terminal-capture'
import { API_BASE } from '$lib/api/config'

export interface TerminalToolEntry {
  def: ClientTool
  run: (
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<unknown>
}

type VerificationDecision = `allow` | `prompt` | `forbidden`

interface VerificationPrecheck {
  decision: VerificationDecision
  reason: string
  guarded: boolean
}

/**
 * Ask the backend's shared verification policy before touching the PTY.
 *
 * This intentionally runs for every client-direct run/send_keys request.  A
 * local TypeScript heuristic would either drift from the MCP policy or permit
 * a new shell wrapper the Python classifier already knows.  Network/protocol
 * failures reject the tool call: executing first and checking later would make
 * the gate advisory instead of fail-closed.
 */
export async function verification_precheck(
  action: `run` | `send_keys`,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<VerificationPrecheck> {
  const body = {
    action,
    ...(action === `run`
      ? { command: String(input.command ?? ``) }
      : { keys: String(input.keys ?? ``) }),
    ...(context?.tab_id ? { panel_id: context.tab_id } : {}),
  }
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}/terminal/verification-precheck`, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        ...(context?.tab_id ? { 'X-CatGo-Tab-Id': context.tab_id } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(
      `Terminal verification precheck unavailable; command was not executed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => `${resp.status}`)
    throw new Error(
      `Terminal verification precheck failed (${resp.status}); command was not executed: ${detail}`,
    )
  }
  let result: Partial<VerificationPrecheck>
  try {
    result = await resp.json() as Partial<VerificationPrecheck>
  } catch {
    throw new Error(`Terminal verification precheck returned invalid JSON; command was not executed.`)
  }
  const decision = result.decision
  if (decision !== `allow` && decision !== `prompt` && decision !== `forbidden`) {
    throw new Error(`Terminal verification precheck returned an invalid decision; command was not executed.`)
  }
  if (decision !== `allow`) {
    const fallback = decision === `prompt`
      ? `Terminal scheduler submission requires an authenticated verification override; command was not executed.`
      : `Terminal scheduler submission is blocked by verification policy.`
    throw new Error(result.reason || fallback)
  }
  return {
    decision,
    reason: typeof result.reason === `string` ? result.reason : ``,
    guarded: result.guarded === true,
  }
}

async function active() {
  const h = await ensure_active_terminal()
  if (!h) throw new Error('No terminal is open and one could not be started.')
  return h
}

function info(h: { session_id: string; host?: string; is_remote: boolean }) {
  return { target: h.is_remote ? `remote (${h.host ?? h.session_id})` : 'local shell' }
}

export const TERMINAL_TOOLS: TerminalToolEntry[] = [
  {
    def: {
      name: 'read_terminal',
      kind: 'read',
      description: 'Read the current visible text of the active terminal pane (last N lines). Use to inspect output, prompts, or state before acting.',
      input_schema: {
        type: 'object',
        properties: { lines: { type: 'number', description: 'How many trailing lines to read (default 40).' } },
      },
    },
    run: async (input) => {
      const h = await active()
      const lines = typeof input.lines === 'number' ? input.lines : 40
      return { output: h.read_buffer(lines), ...info(h) }
    },
  },
  {
    def: {
      name: 'run_command',
      kind: 'mutate',
      description: 'Run a non-interactive shell command in the active terminal pane and return its output + exit code. If output shows a prompt or `running` is true, the command may be waiting for input — use send_keys. Works for local and HPC terminals. NOTE: inside tmux or a full-screen TUI (vim/less/htop), this cannot capture output — it returns a notice; drive those with send_keys (type the command + "<enter>") then read_terminal.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run.' } },
        required: ['command'],
      },
    },
    run: async (input, context) => {
      await verification_precheck(`run`, input, context)
      const h = await active()
      const r = await h.run_command(String(input.command ?? ''))
      return { ...r, ...info(h) }
    },
  },
  {
    def: {
      name: 'send_keys',
      kind: 'mutate',
      description: 'Send keystrokes to the active terminal (for interactive prompts/TUIs). Literal text plus named keys: <enter> <tab> <esc> <backspace> <space> <up> <down> <left> <right> <c-c> <c-d> <c-z>. Example: "y<enter>".',
      input_schema: {
        type: 'object',
        properties: { keys: { type: 'string', description: 'Keys to send, e.g. "y<enter>" or "<c-c>".' } },
        required: ['keys'],
      },
    },
    run: async (input, context) => {
      await verification_precheck(`send_keys`, input, context)
      const h = await active()
      await h.send_keys(resolve_keys(String(input.keys ?? '')))
      await new Promise((r) => setTimeout(r, 200))
      return { output: h.read_buffer(40), ...info(h) }
    },
  },
  {
    def: {
      name: 'interrupt_terminal',
      kind: 'mutate',
      description: 'Send Ctrl-C to the active terminal to interrupt the running command.',
      input_schema: { type: 'object', properties: {} },
    },
    run: async (_input) => {
      const h = await active()
      await h.interrupt()
      await new Promise((r) => setTimeout(r, 200))
      return { output: h.read_buffer(40), ...info(h) }
    },
  },
]
