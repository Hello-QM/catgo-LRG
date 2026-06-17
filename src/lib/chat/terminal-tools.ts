/**
 * CatBot tools that read/operate the visible terminal pane. Each `run` resolves
 * the active terminal handle (auto-spawning a local one if none) and calls into
 * it. Registered into CLIENT_TOOLS by structure-tools.ts. Mutating tools are
 * gated by the existing PermissionCard flow (kind: 'mutate').
 */
import type { ClientTool } from './types'
import { ensure_active_terminal } from '../structure/terminal-registry.svelte'
import { resolve_keys } from '../structure/terminal-capture'

export interface TerminalToolEntry {
  def: ClientTool
  run: (input: Record<string, unknown>) => Promise<unknown>
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
    run: async (input) => {
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
    run: async (input) => {
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
