import type { ChatMessage } from './types'

export interface SessionSummary {
  session_id: string
  agent: string
  topic: string
  created_at: number
  last_active: number
  message_count: number
  model?: string
}

export interface SlashCtx {
  tab_id: string
  args: string
  new_session: () => void
  clear_chat_history: () => void
  cancel_generation: () => void
  resume_session: (agent: string, session_id: string, messages?: ChatMessage[], tab_id?: string) => void
  list_sessions: () => SessionSummary[]
  load_session_messages: (session_id: string) => ChatMessage[]
  run_quickbuild: (recipe: string, mp_id?: string) => Promise<void>
  inject_structure: () => Promise<void>
  set_skip_permission: (on: boolean) => void
  get_skip_permission: () => boolean
  emit: (msg: string) => void
}

export interface SlashCommand {
  name: string
  aliases?: string[]
  hint?: string
  summary: string
  run: (ctx: SlashCtx) => Promise<void> | void
}

// Registry is appended to by later tasks. Keep ONE array; never duplicate.
export const SLASH_COMMANDS: SlashCommand[] = []

function find(token: string): SlashCommand | undefined {
  const t = token.toLowerCase()
  return SLASH_COMMANDS.find(c => c.name === t || c.aliases?.includes(t))
}

/** Parse a raw input string. Returns null if it is not a slash command
 *  (no leading "/", or first token does not resolve to a registered
 *  command). Whitespace-tolerant, case-insensitive. */
export function match_slash(raw: string): { cmd: SlashCommand; args: string } | null {
  const s = raw.trimStart()
  if (!s.startsWith('/')) return null
  const body = s.slice(1)
  const sp = body.search(/\s/)
  const token = sp === -1 ? body : body.slice(0, sp)
  const args = sp === -1 ? '' : body.slice(sp + 1).trim()
  // token '' (bare "/") → no match here; T9 autocomplete intentionally uses the empty token to list all commands.
  const cmd = find(token)
  return cmd ? { cmd, args } : null
}

/** Run a slash command. Returns true if `raw` was a slash attempt
 *  (handled or reported as unknown — caller must NOT fall through to
 *  send_message), false if it was ordinary chat input. */
export async function run_slash(raw: string, ctx: SlashCtx): Promise<boolean> {
  const s = raw.trimStart()
  if (!s.startsWith('/')) return false
  const m = match_slash(raw)
  if (!m) {
    ctx.emit(`Unknown command. Type /help to see available commands.`)
    return true
  }
  try {
    await m.cmd.run({ ...ctx, args: m.args })
  } catch (e) {
    ctx.emit(`Command /${m.cmd.name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return true
}

SLASH_COMMANDS.push({
  name: 'help',
  hint: '',
  summary: 'List all slash commands',
  run(ctx) {
    const lines = SLASH_COMMANDS
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `**/${c.name}**${c.hint ? ' ' + c.hint : ''} — ${c.summary}`)
    ctx.emit(`**CatBot slash commands**\n\n${lines.join('\n')}`)
  },
})

SLASH_COMMANDS.push(
  {
    name: 'new', hint: '', summary: 'Start a fresh chat session',
    run(ctx) { ctx.new_session() },
  },
  {
    name: 'clear', hint: '', summary: 'Clear messages, keep the session',
    run(ctx) { ctx.clear_chat_history() },
  },
  {
    name: 'stop', hint: '', summary: 'Stop the current streaming reply',
    run(ctx) { ctx.cancel_generation() },
  },
)
