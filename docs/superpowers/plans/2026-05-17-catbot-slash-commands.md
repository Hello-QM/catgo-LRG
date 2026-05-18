# CatBot Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, zero-LLM-token client-side slash commands to CatBot (`/new /clear /stop /resume /oer /her /co2rr /nrr /structure /skip-permission /help`) with autocomplete.

**Architecture:** A single registry module (`src/lib/chat/slash-commands.ts`) is the one source of truth for parsing, command behavior, `/help`, and autocomplete. `ChatPane.handle_send` intercepts `/`-prefixed input before the DOI branch and `send_message`, dispatching via the registry with injected context accessors (registry has no UI imports → unit-testable). `/skip-permission` is a session-scoped flag threaded into the Claude adapter `canUseTool` exactly the way the existing `tabId` is threaded.

**Tech Stack:** Svelte 5 runes (`$state`/`$derived`), TypeScript, vitest, Claude Agent SDK agent-bridge.

**Spec:** `docs/superpowers/specs/2026-05-17-catbot-slash-commands-design.md`

---

### Task 1: Registry module — types, `match_slash`, `run_slash`, `/help`

**Files:**
- Create: `src/lib/chat/slash-commands.ts`
- Test: `tests/vitest/chat/slash-commands.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/vitest/chat/slash-commands.test.ts
import { describe, it, expect, vi } from 'vitest'
import { match_slash, run_slash, SLASH_COMMANDS, make_test_ctx } from '$lib/chat/slash-commands'

function ctx(over = {}) {
  return {
    tab_id: 'default', args: '',
    new_session: vi.fn(), clear_chat_history: vi.fn(), cancel_generation: vi.fn(),
    resume_session: vi.fn(), list_sessions: vi.fn(() => []), load_session_messages: vi.fn(() => []),
    run_quickbuild: vi.fn(async () => {}), inject_structure: vi.fn(async () => {}),
    set_skip_permission: vi.fn(), get_skip_permission: vi.fn(() => false),
    emit: vi.fn(),
    ...over,
  }
}

describe('match_slash', () => {
  it('returns null for non-slash', () => {
    expect(match_slash('hello')).toBeNull()
    expect(match_slash('  hi /new')).toBeNull()
  })
  it('matches command name case-insensitively with args', () => {
    const m = match_slash('/OER mp-1019')
    expect(m?.cmd.name).toBe('oer')
    expect(m?.args).toBe('mp-1019')
  })
  it('matches with no args and trims', () => {
    const m = match_slash('  /new  ')
    expect(m?.cmd.name).toBe('new')
    expect(m?.args).toBe('')
  })
  it('returns null for unknown slash token', () => {
    expect(match_slash('/bogus')).toBeNull()
  })
  it('resolves aliases', () => {
    const m = match_slash('/co2rr')
    expect(m?.cmd.name).toBe('co2rr')
  })
})

describe('run_slash', () => {
  it('returns false when not a command (no UI side effects)', async () => {
    const c = ctx()
    expect(await run_slash('plain text', c as any)).toBe(false)
    expect(c.emit).not.toHaveBeenCalled()
  })
  it('emits unknown-command help hint for unmatched slash', async () => {
    const c = ctx()
    expect(await run_slash('/nope', c as any)).toBe(true)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('/help'))
  })
  it('/help lists every registered command', async () => {
    const c = ctx()
    await run_slash('/help', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    for (const cmd of SLASH_COMMANDS) expect(out).toContain('/' + cmd.name)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: FAIL — module `$lib/chat/slash-commands` not found.

- [ ] **Step 3: Implement registry core**

```ts
// src/lib/chat/slash-commands.ts
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
  hint: string
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
    await m.run({ ...ctx, args: m.args })
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
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: PASS (the alias/quickbuild tests for `/co2rr` will fail until Task 4 — comment them out is NOT allowed; instead this task's test file only includes the assertions shown in Step 1, and `/co2rr` alias test is part of Step 1 but `co2rr` is registered in Task 4. To keep Task 1 green, the `resolves aliases` test uses `/help` which has no alias → change that test now:)

Edit `tests/vitest/chat/slash-commands.test.ts` `resolves aliases` test:
```ts
  it('first token resolves to the help command', () => {
    const m = match_slash('/HELP')
    expect(m?.cmd.name).toBe('help')
  })
```
Also remove the `/OER` and `/co2rr` cases from Step 1's `match_slash` block (they belong to Task 4); keep only non-slash, `/new`-style (use `/help`), unknown, trim cases:
```ts
  it('matches command name case-insensitively with args', () => {
    const m = match_slash('/HELP extra args')
    expect(m?.cmd.name).toBe('help')
    expect(m?.args).toBe('extra args')
  })
```
Re-run. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/slash-commands.ts tests/vitest/chat/slash-commands.test.ts
git commit -m "feat(catbot): slash-command registry core + match/run + /help"
```

---

### Task 2: Session-control commands `/new` `/clear` `/stop`

**Files:**
- Modify: `src/lib/chat/slash-commands.ts` (append to `SLASH_COMMANDS`)
- Test: `tests/vitest/chat/slash-commands.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

```ts
describe('session commands', () => {
  it('/new calls new_session', async () => {
    const c = ctx(); await run_slash('/new', c as any)
    expect(c.new_session).toHaveBeenCalledTimes(1)
  })
  it('/clear calls clear_chat_history', async () => {
    const c = ctx(); await run_slash('/clear', c as any)
    expect(c.clear_chat_history).toHaveBeenCalledTimes(1)
  })
  it('/stop calls cancel_generation', async () => {
    const c = ctx(); await run_slash('/stop', c as any)
    expect(c.cancel_generation).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts -t "session commands"`
Expected: FAIL — `/new` unmatched → emit called, `new_session` not called.

- [ ] **Step 3: Register the three commands**

Append to `src/lib/chat/slash-commands.ts` (after the `help` push):

```ts
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
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/slash-commands.ts tests/vitest/chat/slash-commands.test.ts
git commit -m "feat(catbot): /new /clear /stop slash commands"
```

---

### Task 3: `/resume` with readable session list

**Files:**
- Modify: `src/lib/chat/slash-commands.ts`
- Test: `tests/vitest/chat/slash-commands.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe('/resume', () => {
  const sessions = [
    { session_id: 'sB', agent: 'claude', topic: 'OER on RuO2', created_at: 1, last_active: 200, message_count: 4 },
    { session_id: 'sA', agent: 'claude', topic: '', created_at: 1, last_active: 100, message_count: 2 },
  ]
  it('no args lists sessions newest-first with topic + snippet, never raw id alone', async () => {
    const c = ctx({
      list_sessions: vi.fn(() => sessions),
      load_session_messages: vi.fn((id: string) =>
        id === 'sB' ? [{ role: 'user', content: 'hi', timestamp: 1 },
                        { role: 'assistant', content: 'Here is the OER workflow summary text', timestamp: 2 }]
                     : [{ role: 'user', content: 'plain question about slab', timestamp: 1 }]),
    })
    await run_slash('/resume', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    expect(out.indexOf('1.')).toBeLessThan(out.indexOf('2.')) // newest (sB) first
    expect(out).toContain('OER on RuO2')                       // topic shown
    expect(out).toContain('Here is the OER workflow')          // last-message snippet
    expect(out).toContain('plain question about slab')         // fallback snippet when topic empty
    expect(c.resume_session).not.toHaveBeenCalled()
  })
  it('numeric arg resumes the nth listed session', async () => {
    const c = ctx({
      list_sessions: vi.fn(() => sessions),
      load_session_messages: vi.fn(() => [{ role: 'user', content: 'x', timestamp: 1 }]),
    })
    await run_slash('/resume 1', c as any)
    expect(c.resume_session).toHaveBeenCalledWith('claude', 'sB',
      [{ role: 'user', content: 'x', timestamp: 1 }], 'default')
  })
  it('out-of-range index emits a usage note, does not throw or resume', async () => {
    const c = ctx({ list_sessions: vi.fn(() => sessions) })
    await run_slash('/resume 9', c as any)
    expect(c.resume_session).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('1–2'))
  })
  it('empty session list emits a note', async () => {
    const c = ctx({ list_sessions: vi.fn(() => []) })
    await run_slash('/resume', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('No past sessions'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts -t "/resume"`
Expected: FAIL — `/resume` unmatched.

- [ ] **Step 3: Implement `/resume`**

Append to `src/lib/chat/slash-commands.ts`:

```ts
function rel_time(ms: number): string {
  const d = Date.now() - ms
  const m = Math.round(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

> ⚠️ Corrected during execution: the shipped `snippet()` combines topic AND last-message (`${topic} — ${preview}`) via `get_display_text()`, per design doc §/resume line 102 (topic + last-message snippet). The block below is the pre-correction draft, kept for history. See `src/lib/chat/slash-commands.ts` for the authoritative implementation.

function snippet(ctx: SlashCtx, s: SessionSummary): string {
  const msgs = ctx.load_session_messages(s.session_id)
  const last = msgs.length ? msgs[msgs.length - 1].content : ''
  const text = (s.topic && s.topic.trim()) || last || '(empty)'
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
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
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/slash-commands.ts tests/vitest/chat/slash-commands.test.ts
git commit -m "feat(catbot): /resume with topic+snippet session list"
```

---

### Task 4: Quickbuild commands `/oer` `/her` `/co2rr` `/nrr`

**Files:**
- Modify: `src/lib/chat/slash-commands.ts`
- Test: `tests/vitest/chat/slash-commands.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe('quickbuild commands', () => {
  it('/oer with no args calls run_quickbuild("oer", undefined)', async () => {
    const c = ctx(); await run_slash('/oer', c as any)
    expect(c.run_quickbuild).toHaveBeenCalledWith('oer', undefined)
  })
  it('/her mp-1019 passes the mp id', async () => {
    const c = ctx(); await run_slash('/her mp-1019', c as any)
    expect(c.run_quickbuild).toHaveBeenCalledWith('her', 'mp-1019')
  })
  it('/co2rr and /nrr are registered', async () => {
    const c1 = ctx(); await run_slash('/co2rr', c1 as any)
    expect(c1.run_quickbuild).toHaveBeenCalledWith('co2rr', undefined)
    const c2 = ctx(); await run_slash('/nrr', c2 as any)
    expect(c2.run_quickbuild).toHaveBeenCalledWith('nrr', undefined)
  })
  it('rejects a malformed mp id with a usage note, no quickbuild call', async () => {
    const c = ctx(); await run_slash('/oer notanid', c as any)
    expect(c.run_quickbuild).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('mp-'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts -t "quickbuild commands"`
Expected: FAIL — commands unmatched.

- [ ] **Step 3: Implement (one parameterised factory — no per-recipe copies)**

Append to `src/lib/chat/slash-commands.ts`:

```ts
const RECIPES: { name: string; label: string }[] = [
  { name: 'oer', label: 'OER' },
  { name: 'her', label: 'HER' },
  { name: 'co2rr', label: 'CO2RR' },
  { name: 'nrr', label: 'NRR' },
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
      await ctx.run_quickbuild(r.name, a === '' ? undefined : a)
    },
  })
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/slash-commands.ts tests/vitest/chat/slash-commands.test.ts
git commit -m "feat(catbot): /oer /her /co2rr /nrr quickbuild slash commands"
```

---

### Task 5: `/structure` and `/skip-permission` registry behavior

**Files:**
- Modify: `src/lib/chat/slash-commands.ts`
- Test: `tests/vitest/chat/slash-commands.test.ts`

(Threading `skip_permission` into the stream chain is Task 7. This task only registers the command + its registry-level state calls.)

- [ ] **Step 1: Add failing tests**

```ts
describe('/structure', () => {
  it('calls inject_structure', async () => {
    const c = ctx(); await run_slash('/structure', c as any)
    expect(c.inject_structure).toHaveBeenCalledTimes(1)
  })
})

describe('/skip-permission', () => {
  it('no arg reports current state', async () => {
    const c = ctx({ get_skip_permission: vi.fn(() => false) })
    await run_slash('/skip-permission', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('OFF'))
    expect(c.set_skip_permission).not.toHaveBeenCalled()
  })
  it('on sets true and emits a security warning', async () => {
    const c = ctx(); await run_slash('/skip-permission on', c as any)
    expect(c.set_skip_permission).toHaveBeenCalledWith(true)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('⚠️'))
  })
  it('off sets false', async () => {
    const c = ctx(); await run_slash('/skip-permission off', c as any)
    expect(c.set_skip_permission).toHaveBeenCalledWith(false)
  })
  it('garbage arg emits usage, does not change state', async () => {
    const c = ctx(); await run_slash('/skip-permission maybe', c as any)
    expect(c.set_skip_permission).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('on'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts -t "/structure"`
Expected: FAIL — unmatched.

- [ ] **Step 3: Implement**

Append to `src/lib/chat/slash-commands.ts`:

```ts
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
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/slash-commands.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat/slash-commands.ts tests/vitest/chat/slash-commands.test.ts
git commit -m "feat(catbot): /structure + /skip-permission registry behavior"
```

---

### Task 6: `skip_permission` slice state + reset on `/new`

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts` (ChatSlice interface ~line 168, `make_chat_slice` ~174-206, `new_session` ~795)
- Test: `tests/vitest/chat/chat-state-skip.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/vitest/chat/chat-state-skip.test.ts
import { describe, it, expect } from 'vitest'
import { get_chat_slice, new_session } from '$lib/chat/chat-state.svelte'

describe('skip_permission slice state', () => {
  it('defaults false and is reset by new_session', () => {
    const s = get_chat_slice('t-skip')
    expect(s.skip_permission.value).toBe(false)
    s.skip_permission.value = true
    expect(get_chat_slice('t-skip').skip_permission.value).toBe(true)
    new_session(undefined, 't-skip')
    expect(get_chat_slice('t-skip').skip_permission.value).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/vitest/chat/chat-state-skip.test.ts`
Expected: FAIL — `skip_permission` does not exist on slice.

- [ ] **Step 3: Add to ChatSlice interface**

In `src/lib/chat/chat-state.svelte.ts`, in the `ChatSlice` interface (next to `pending_send` ~line 168) add:

```ts
  // Session-scoped tool-approval bypass (NOT persisted — a fresh session
  // always re-gates). Read at send time, threaded into the Claude adapter.
  skip_permission: { value: boolean }
```

In `make_chat_slice()` (~line 192, beside the `pending_send` $state) add:

```ts
  const skip_permission = $state({ value: false })
```

In the returned object (~line 205, beside `pending_send,`) add `skip_permission,`.

- [ ] **Step 4: Reset on new_session**

In `new_session()` (~line 795), after the existing `slice.messages.list = []` / error reset lines, add:

```ts
  slice.skip_permission.value = false
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run tests/vitest/chat/chat-state-skip.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts tests/vitest/chat/chat-state-skip.test.ts
git commit -m "feat(catbot): per-session skip_permission slice state"
```

---

### Task 7: Thread `skipPermissions` through the stream chain into `canUseTool`

**Files:**
- Modify: `src/lib/chat/chat-state.svelte.ts` (the `send_message` agent-stream call — locate where it passes `tabId` to the stream params)
- Modify: `src/lib/chat/sdk-stream.ts:42` (StreamParams type), `:55` (destructure), `:60` (fetch body)
- Modify: `src/lib/server/agent-bridge/server.ts:97` (destructure), `:142-144` (pass to adapter)
- Modify: `src/lib/server/agent-bridge/types.ts` (StreamParams interface — add beside `tabId`)
- Modify: `src/lib/server/agent-bridge/adapters/claude.ts:170-180` (destructure params), `:212-214` (canUseTool gate)

**Pattern:** `skipPermissions?: boolean` is threaded EXACTLY parallel to the existing `tabId` — at every site where `tabId` appears in these files, add `skipPermissions` the same way.

- [ ] **Step 1: types.ts — add field**

In `src/lib/server/agent-bridge/types.ts`, in the `StreamParams` interface, directly below the `tabId?: string` field (and its doc comment) add:

```ts
  /**
   * When true, the Claude adapter's canUseTool auto-allows ALL tools
   * (not just CatGo MCP) without showing the PermissionCard, for this
   * stream only. Set per-stream from the chat slice's session-scoped
   * skip_permission flag; never persisted.
   */
  skipPermissions?: boolean
```

- [ ] **Step 2: claude.ts — destructure + enforce**

In `src/lib/server/agent-bridge/adapters/claude.ts`, the `stream(params)` destructure block (currently `const { prompt, sessionId, model, systemPrompt, cwd, mcpServerUrl, permissionCallback, abortSignal, tabId } = params`) — add `skipPermissions` to it:

```ts
      const {
        prompt, sessionId, model, systemPrompt, cwd, mcpServerUrl,
        permissionCallback, abortSignal, tabId, skipPermissions,
      } = params
```

In `canUseTool`, immediately after the existing CatGo auto-allow block:

```ts
        if (toolName.startsWith('mcp__catgo__') || toolName.startsWith('catgo_')) {
          return { behavior: 'allow' }
        }
        // Session-scoped user opt-out of the approval gate (/skip-permission).
        // Captured per-stream so a mid-stream toggle can't retroactively
        // affect an in-flight round.
        if (skipPermissions) {
          return { behavior: 'allow' }
        }
```

- [ ] **Step 3: server.ts — accept + forward**

In `src/lib/server/agent-bridge/server.ts:97`, add `skipPermissions` to the body destructure:

```ts
  const { agent, prompt, sessionId, model, systemPrompt, attachments, tabId, chatId, skipPermissions } = body
```

At `:142-144` where the adapter `StreamParams` object is built (where `tabId,` is passed), add `skipPermissions,` beside it.

- [ ] **Step 4: sdk-stream.ts — type + send**

In `src/lib/chat/sdk-stream.ts:42` (StreamParams-like type with `tabId?: string`) add `skipPermissions?: boolean`.
At `:55` destructure add `skipPermissions`.
At `:60` the fetch body — add `skipPermissions` to the `JSON.stringify({ ... })`:

```ts
    body: JSON.stringify({ agent, prompt, sessionId, model, systemPrompt, attachments, tabId, chatId, skipPermissions }),
```

- [ ] **Step 5: chat-state.svelte.ts — pass slice flag at send time**

In `src/lib/chat/chat-state.svelte.ts`, in `send_message`, find the agent-stream call site that already passes `tabId` (the SDK Agent path). Add `skipPermissions: slice.skip_permission.value` to that params object, beside `tabId`.

- [ ] **Step 6: Typecheck**

Run: `pnpm check 2>&1 | grep -E 'svelte-check found|adapters/claude|sdk-stream|agent-bridge/server|agent-bridge/types|chat-state'`
Expected: `svelte-check found 0 errors` (292 pre-existing warnings unchanged); no errors in the listed files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/chat-state.svelte.ts src/lib/chat/sdk-stream.ts src/lib/server/agent-bridge/types.ts src/lib/server/agent-bridge/server.ts src/lib/server/agent-bridge/adapters/claude.ts
git commit -m "feat(catbot): thread session skipPermissions into canUseTool"
```

---

### Task 8: ChatPane dispatch + skip banner

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte` — imports, `handle_send` (~622-665), `input-hint-row` (~1397)

- [ ] **Step 1: Import registry + state exports**

At the ChatPane `<script>` import block (where `load_session_messages`, `new_session`, `clear_chat_history`, `cancel_generation`, `resume_session`, `session_list` are already imported from `./chat-state.svelte`), add `run_slash` and a local emit helper. Add import:

```ts
  import { run_slash } from './slash-commands'
  import { get_current_structure } from '$lib/structure/current-structure.svelte'
```

- [ ] **Step 2: Build ctx + intercept in handle_send**

In `handle_send`, immediately after `active_tab = `chat`` and BEFORE the `const doi_match = ...` line, insert:

```ts
    // Slash commands: intercept before DOI / send_message. A "/"-prefixed
    // line never reaches the LLM. Unknown "/x" is reported locally.
    if (msg.startsWith(`/`)) {
      const emit_note = (text: string) => {
        slice.messages.list = [...slice.messages.list,
          { role: `assistant`, content: text, timestamp: Date.now() }]
      }
      const handled = await run_slash(msg, {
        tab_id: tab_slice_id,
        args: ``,
        new_session: () => new_session(SDK_PROVIDERS.has(chat_config.provider) ? chat_config.provider.replace(`sdk-`, ``) : undefined, tab_slice_id),
        clear_chat_history: () => clear_chat_history(tab_slice_id),
        cancel_generation: () => cancel_generation(tab_slice_id),
        resume_session: (agent, sid, messages, tid) => resume_session(agent, sid, messages, tid ?? tab_slice_id),
        list_sessions: () => session_list.list,
        load_session_messages: (sid) => load_session_messages(sid),
        run_quickbuild: async (recipe, mp_id) => {
          const resp = await fetch(`${API_BASE}/workflow/quickbuild`, {
            method: `POST`, headers: { 'Content-Type': `application/json` },
            body: JSON.stringify(mp_id ? { recipe, material_id: mp_id } : { recipe }),
          })
          if (!resp.ok) throw new Error((await resp.text().catch(() => String(resp.status))).slice(0, 200))
          const data = await resp.json()
          const wf_id = data.workflow_id
          if (wf_id) {
            const wf_state = await import(`$lib/workflow/workflow-state.svelte`)
            const wfslice = wf_state.get_workflow_slice(tab_slice_id)
            wfslice.pending_navigate_workflow.id = wf_id
            wfslice.workflow_reload_seq.seq++
          }
          emit_note(`✅ ${recipe.toUpperCase()} workflow built${mp_id ? ` for ${mp_id}` : ``}.`)
        },
        inject_structure: async () => {
          const cur = get_current_structure()
          if (!cur) { emit_note(`No structure loaded — open one in a structure viewer first.`); return }
          const wf_state = await import(`$lib/workflow/workflow-state.svelte`)
          const wfslice = wf_state.get_workflow_slice(tab_slice_id)
          wfslice.workflow_reload_seq.seq++
          emit_note(`Structure pushed — open the Workflow editor; the Structure Input node will pick it up.`)
        },
        set_skip_permission: (on) => { slice.skip_permission.value = on },
        get_skip_permission: () => slice.skip_permission.value,
        emit: emit_note,
      })
      if (handled) return
    }
```

(Note: `API_BASE`, `SDK_PROVIDERS`, `chat_config` are already imported/in-scope in ChatPane — verify with `grep -n 'API_BASE\|SDK_PROVIDERS\|chat_config' src/lib/chat/ChatPane.svelte | head`. If `API_BASE` is not imported, add `import { API_BASE } from '$lib/api/config'`.)

- [ ] **Step 3: Skip-permission banner in input-hint-row**

In `src/lib/chat/ChatPane.svelte` `input-hint-row` (~line 1397), as the FIRST child branch (before the `slice.pending_send` check):

```svelte
        {#if slice.skip_permission.value}
          <span class="input-hint skip-warn">⚠️ skip-permission ON — tools run without asking</span>
        {:else if slice.pending_send?.value}
```

(Change the existing `{#if slice.pending_send?.value}` to `{:else if slice.pending_send?.value}` so it chains.)

Add to ChatPane `<style>`:

```css
  .input-hint.skip-warn {
    color: var(--error-color);
    font-weight: 600;
  }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check 2>&1 | grep -E 'svelte-check found|ChatPane'`
Expected: `svelte-check found 0 errors`; no error in ChatPane.svelte.

- [ ] **Step 5: Manual smoke (documented, not automated)**

Hard-reload browser. In CatBot type `/help` → local list appears, nothing sent to LLM. `/new` → fresh session. `/oer mp-1019` → workflow builds, editor opens. `/skip-permission on` → red banner appears in input row; `/new` → banner gone. Type `hello` → normal LLM message (regression).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/ChatPane.svelte
git commit -m "feat(catbot): wire slash-command dispatch + skip-permission banner"
```

---

### Task 9: Autocomplete dropdown + keyboard interception

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte` — script state, textarea `onkeydown`, dropdown markup above `.input-wrapper` (~line 1312), `<style>`

- [ ] **Step 1: Add filter state (script)**

In ChatPane `<script>`, add:

```ts
  import { SLASH_COMMANDS } from './slash-commands'

  let slash_idx = $state(0)
  const slash_filtered = $derived.by(() => {
    const s = input_text
    if (!s.startsWith(`/`) || /\s/.test(s)) return []
    const tok = s.slice(1).toLowerCase()
    return SLASH_COMMANDS
      .filter(c => c.name.startsWith(tok) || c.aliases?.some(a => a.startsWith(tok)))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  const slash_open = $derived(slash_filtered.length > 0)
  $effect(() => { if (slash_idx >= slash_filtered.length) slash_idx = 0 })

  function apply_slash_selection() {
    const c = slash_filtered[slash_idx]
    if (!c) return
    input_text = `/${c.name} `
    slash_idx = 0
    textarea_el?.focus()
  }
```

- [ ] **Step 2: Intercept keys in handle_keydown**

Replace the body of `handle_keydown` (~667) with:

```ts
  function handle_keydown(event: KeyboardEvent) {
    if (slash_open) {
      if (event.key === `ArrowDown`) {
        event.preventDefault()
        slash_idx = (slash_idx + 1) % slash_filtered.length
        return
      }
      if (event.key === `ArrowUp`) {
        event.preventDefault()
        slash_idx = (slash_idx - 1 + slash_filtered.length) % slash_filtered.length
        return
      }
      if (event.key === `Tab` || (event.key === `Enter` && !event.shiftKey)) {
        event.preventDefault()
        apply_slash_selection()
        return
      }
      if (event.key === `Escape`) {
        event.preventDefault()
        input_text = input_text + ` ` // typing a space closes the menu (args phase) without clearing
        return
      }
    }
    if (event.key === `Enter` && !event.shiftKey) {
      event.preventDefault()
      handle_send()
    }
  }
```

- [ ] **Step 3: Dropdown markup**

Immediately BEFORE `<div class="input-wrapper" class:focused={false}>` (~line 1312) add:

```svelte
      {#if slash_open}
        <div class="slash-menu" role="listbox">
          {#each slash_filtered as c, i (c.name)}
            <button
              type="button"
              class="slash-row"
              class:sel={i === slash_idx}
              role="option"
              aria-selected={i === slash_idx}
              onmousedown={(e) => { e.preventDefault(); slash_idx = i; apply_slash_selection() }}
            >
              <span class="slash-name">/{c.name}{c.hint ? ` ${c.hint}` : ``}</span>
              <span class="slash-summary">{c.summary}</span>
            </button>
          {/each}
        </div>
      {/if}
```

- [ ] **Step 4: Styles (theme vars only — no hardcoded palette)**

Add to ChatPane `<style>`:

```css
  .slash-menu {
    display: flex;
    flex-direction: column;
    max-height: 240px;
    overflow-y: auto;
    margin: 0 0 4px 0;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--surface-bg, var(--pane-card-bg));
  }
  .slash-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 5px 9px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .slash-row:last-child { border-bottom: none; }
  .slash-row.sel,
  .slash-row:hover {
    background: color-mix(in srgb, var(--accent-color) 16%, transparent);
  }
  .slash-name {
    font-family: monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color);
  }
  .slash-summary {
    font-size: 11px;
    color: var(--text-color-muted);
  }
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check 2>&1 | grep -E 'svelte-check found|ChatPane'`
Expected: `svelte-check found 0 errors`; no error in ChatPane.svelte.

- [ ] **Step 6: Manual smoke**

Hard-reload. Type `/` → menu lists all commands. Type `/o` → filters to `/oer`. `↓`/`↑` move highlight. `Tab` fills `/oer ` (no send, focus kept). `Enter` on highlighted = same. Type a space → menu closes (args phase). With menu closed, `Enter` sends normally (regression). `Esc` with menu open closes it without clearing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/ChatPane.svelte
git commit -m "feat(catbot): slash-command autocomplete dropdown + keyboard nav"
```

---

## Self-Review

**Spec coverage:**
- Architecture / registry / dispatch → Task 1, Task 8 ✓
- Command set (/new /clear /stop) → Task 2 ✓; /resume preview → Task 3 ✓; quickbuild → Task 4 ✓; /structure + /skip-permission registry → Task 5 ✓; /help → Task 1 ✓
- Security /skip-permission state + enforcement + banner → Tasks 6, 7, 8 ✓
- Autocomplete → Task 9 ✓
- Error handling (unknown cmd, bad args, run throws, queue-while-streaming) → Task 1 (`run_slash` try/catch + unknown emit), Tasks 3/4/5 (usage notes) ✓. Note: queue-while-streaming reuses existing `pending_send`; slash commands run synchronously in `handle_send` before that path, so a slash command typed mid-stream executes immediately (e.g. `/stop` works) — consistent with spec intent; no extra code needed.
- Testing → unit tests Tasks 1-5, slice test Task 6, typecheck Tasks 7-9, documented manual smoke Tasks 8-9 ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. Task 1 Step 4 explicitly reconciles the test split (alias/quickbuild cases moved to Task 4) so Task 1 stays green standalone.

**Type consistency:** `SlashCtx`/`SlashCommand`/`SLASH_COMMANDS`/`match_slash`/`run_slash` defined Task 1, used unchanged Tasks 2-9. `skip_permission.value` (slice) Task 6 ↔ `get/set_skip_permission` ctx Task 5 ↔ `skipPermissions` stream field Task 7 — names consistent across layers. `run_quickbuild(recipe, mp_id?)` signature consistent Task 4 ↔ Task 8 impl. `get_current_structure` matches the existing `src/lib/structure/current-structure.svelte.ts` export from prior session work.

No gaps found.
