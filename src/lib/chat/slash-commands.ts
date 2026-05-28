import type { ChatMessage, SessionSummary } from './types'
import { get_display_text } from './types'
import { t, load_i18n_module } from '$lib/i18n/index.svelte'

const chat_i18n_ready = load_i18n_module('chat')

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
  await chat_i18n_ready
  const m = match_slash(raw)
  if (!m) {
    ctx.emit(t('chat.unknown_command'))
    return true
  }
  try {
    await m.cmd.run({ ...ctx, args: m.args })
  } catch (e) {
    ctx.emit(t('chat.slash_command_failed', { name: m.cmd.name, message: e instanceof Error ? e.message : String(e) }))
  }
  return true
}

SLASH_COMMANDS.push({
  name: 'help',
  hint: '',
  get summary() { return t('chat.slash_help_summary') },
  run(ctx) {
    const lines = SLASH_COMMANDS
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `**/${c.name}**${c.hint ? ' ' + c.hint : ''} — ${c.summary}`)
    ctx.emit(`**${t('chat.slash_commands_title')}**\n\n${lines.join('\n')}`)
  },
})

SLASH_COMMANDS.push(
  {
    name: 'new', hint: '', get summary() { return t('chat.slash_new_summary') },
    run(ctx) { ctx.new_session() },
  },
  {
    name: 'clear', hint: '', get summary() { return t('chat.slash_clear_summary') },
    run(ctx) { ctx.clear_chat_history() },
  },
  {
    name: 'stop', hint: '', get summary() { return t('chat.slash_stop_summary') },
    run(ctx) { ctx.cancel_generation() },
  },
)

function rel_time(ms: number): string {
  const d = Date.now() - ms
  const m = Math.round(d / 60000)
  if (m < 1) return t('chat.rel_time_just_now')
  if (m < 60) return t('chat.rel_time_minutes_ago', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('chat.rel_time_hours_ago', { n: h })
  return t('chat.rel_time_days_ago', { n: Math.round(h / 24) })
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
  else text = topic || preview || t('chat.session_empty')
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

SLASH_COMMANDS.push({
  name: 'resume',
  hint: '[n]',
  get summary() { return t('chat.slash_resume_summary') },
  run(ctx) {
    const sorted = ctx.list_sessions().slice().sort((a, b) => b.last_active - a.last_active)
    if (sorted.length === 0) { ctx.emit(t('chat.no_past_sessions')); return }
    if (ctx.args.trim() === '') {
      const lines = sorted.map((s, i) =>
        `${i + 1}. ${snippet(ctx, s)} · ${rel_time(s.last_active)}`)
      ctx.emit(`**${t('chat.recent_sessions')}** — ${t('chat.resume_open_hint')}\n\n${lines.join('\n')}`)
      return
    }
    const n = Number.parseInt(ctx.args.trim(), 10)
    if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
      ctx.emit(t('chat.resume_expect_number', { n: sorted.length }))
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
    get summary() { return t('chat.quickbuild_workflow', { label: r.label }) },
    async run(ctx) {
      const a = ctx.args.trim()
      if (a !== '' && !/^mp-\d+$/i.test(a)) {
        ctx.emit(t('chat.quickbuild_usage', { name: r.name }))
        return
      }
      await ctx.run_quickbuild(r.recipe, a === '' ? undefined : a)
    },
  })
}

SLASH_COMMANDS.push({
  name: 'structure',
  hint: '',
  get summary() { return t('chat.slash_structure_summary') },
  async run(ctx) { await ctx.inject_structure() },
})

SLASH_COMMANDS.push({
  name: 'skip-permission',
  hint: '[on|off]',
  get summary() { return t('chat.slash_skip_permission_summary') },
  run(ctx) {
    const a = ctx.args.trim().toLowerCase()
    if (a === '') {
      ctx.emit(t('chat.skip_permission_status', { state: ctx.get_skip_permission() ? 'ON' : 'OFF' }))
      return
    }
    if (a === 'on') {
      ctx.set_skip_permission(true)
      ctx.emit(t('chat.skip_permission_on'))
      return
    }
    if (a === 'off') {
      ctx.set_skip_permission(false)
      ctx.emit(t('chat.skip_permission_off'))
      return
    }
    ctx.emit(t('chat.skip_permission_usage'))
  },
})
