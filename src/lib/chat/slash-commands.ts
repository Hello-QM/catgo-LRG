import type { ChatMessage, SessionSummary } from './types'
import { get_display_text } from './types'

export type { SessionSummary } from './types'

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

function rel_time(ms: number): string {
  const d = Date.now() - ms
  const m = Math.round(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function snippet(ctx: SlashCtx, s: SessionSummary): string {
  const msgs = ctx.load_session_messages(s.session_id)
  const last = msgs.length ? get_display_text(msgs[msgs.length - 1].content) : ''
  const topic = (s.topic ?? '').replace(/\s+/g, ' ').trim()
  const preview = last.replace(/\s+/g, ' ').trim()
  // Design: each line shows topic AND a snippet of the last message.
  // topic + preview when both exist; whichever exists alone otherwise.
  let text: string
  if (topic && preview) text = `${topic} — ${preview}`
  else text = topic || preview || '(empty)'
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

SLASH_COMMANDS.push({
  name: 'resume',
  hint: '[n]',
  summary: 'List recent sessions, or resume the nth',
  run(ctx) {
    const sorted = ctx.list_sessions().slice().sort((a, b) => b.last_active - a.last_active)
    if (sorted.length === 0) { ctx.emit('No past sessions found.'); return }
    if (ctx.args.trim() === '') {
      const lines = sorted.map((s, i) =>
        `${i + 1}. ${snippet(ctx, s)} · ${rel_time(s.last_active)}`)
      ctx.emit(`**Recent sessions** — /resume <n> to open one\n\n${lines.join('\n')}`)
      return
    }
    const n = Number.parseInt(ctx.args.trim(), 10)
    if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
      ctx.emit(`/resume expects a number 1–${sorted.length}.`)
      return
    }
    const s = sorted[n - 1]
    const msgs = ctx.load_session_messages(s.session_id)
    ctx.resume_session(s.agent, s.session_id, msgs.length ? msgs : undefined, ctx.tab_id)
  },
})

const RECIPES: { name: string; label: string; recipe: string }[] = [
  { name: 'oer', label: 'OER', recipe: 'OER' },
  { name: 'her', label: 'HER', recipe: 'HER' },
  { name: 'co2rr', label: 'CO2RR', recipe: 'CO2RR_2e' },
  { name: 'nrr', label: 'NRR', recipe: 'NRR' },
]

for (const r of RECIPES) {
  SLASH_COMMANDS.push({
    name: r.name,
    hint: '[mp-id]',
    summary: `Quick-build a ${r.label} workflow (optional Materials Project id)`,
    async run(ctx) {
      const a = ctx.args.trim()
      if (a !== '' && !/^mp-\d+$/i.test(a)) {
        ctx.emit(`Usage: /${r.name} [mp-id] — e.g. /${r.name} mp-1019. Omit the id to use the current structure.`)
        return
      }
      await ctx.run_quickbuild(r.recipe, a === '' ? undefined : a)
    },
  })
}

SLASH_COMMANDS.push({
  name: 'structure',
  hint: '',
  summary: 'Put the current structure into the Structure Input node',
  async run(ctx) { await ctx.inject_structure() },
})

SLASH_COMMANDS.push({
  name: 'skip-permission',
  hint: '[on|off]',
  summary: 'Toggle the per-session tool-approval gate',
  run(ctx) {
    const a = ctx.args.trim().toLowerCase()
    if (a === '') {
      ctx.emit(`skip-permission is ${ctx.get_skip_permission() ? 'ON' : 'OFF'}. Use /skip-permission on|off.`)
      return
    }
    if (a === 'on') {
      ctx.set_skip_permission(true)
      ctx.emit(`⚠️ Permission prompts disabled for this session — Bash and file tools will run without asking. /skip-permission off to re-enable.`)
      return
    }
    if (a === 'off') {
      ctx.set_skip_permission(false)
      ctx.emit(`skip-permission OFF — tool calls will ask for approval again.`)
      return
    }
    ctx.emit(`Usage: /skip-permission on|off`)
  },
})
