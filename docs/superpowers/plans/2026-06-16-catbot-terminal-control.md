# CatBot Terminal Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CatBot (in-app AI Chat) read and operate the visible terminal pane — `read_terminal`, `run_command`, `send_keys`, `interrupt_terminal` — with per-command approval, for local + HPC terminals, plus an "Ask CatBot" button in the terminal header.

**Architecture:** An in-process **terminal registry** bridges chat ↔ the visible PTY. `TerminalPanel` gains `run_command` (inline `BEGIN…END_<exit>` marker capture over `pty.onData`), `send_keys`, `interrupt`, `read_buffer`, and registers a handle. Four CLIENT_TOOLS call the active handle; `kind:'mutate'` reuses the existing PermissionCard gate. "Ask CatBot" splits the terminal leaf and opens a chat panel (`initial_panel='chat'`).

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, xterm.js, vitest, Playwright. Project style: single quotes, **no semicolons**, 2-space indent (write by hand; never run `deno fmt`).

**Spec:** `docs/superpowers/specs/2026-06-16-catbot-terminal-control-design.md`

**Confirmed APIs (do not re-derive):**
- `PtySession` (`src/lib/api/pty.ts`): `write(data: string): Promise<void>`, `onData(cb: (data: Uint8Array) => void): () => void`, `onExit`, `kill`, `resize`.
- Tool registry (`src/lib/chat/structure-tools.ts`): `register(def: ClientTool, run: (input) => Promise<unknown>)`; `execute_tool` routes via REGISTRY; `tool_kind` reads `def.kind`. `ClientTool = { name, description, kind: 'read'|'mutate', input_schema }` (`src/lib/chat/types.ts`).
- Approval: `tool-loop.ts:160` — `kind === 'mutate'` → `permission_request` → `request_permission`. ChatPane already renders `PermissionCard` from `slice.active_permission_blocks.entries`. `skip_permission` flag exists per chat slice. **No tool-loop changes needed.**
- Spawn terminal leaf (App.svelte:2249): `ts.root = setLeafContent(ts.root, leaf.id, { type: 'terminal', term: { sync_cwd: false } })`; get a target leaf via `escalateForImport(ts.root, ts.active_leaf_id)`.
- Open chat panel (App.svelte:2215): `pane.initial_panel = 'chat'`.

---

## Task 1: Pure capture helpers (`terminal-capture.ts`)

**Files:**
- Create: `src/lib/structure/terminal-capture.ts`
- Test: `tests/vitest/terminal-capture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/terminal-capture.test.ts
import { describe, it, expect } from 'vitest'
import { strip_ansi, next_marker, wrap_command, extract_result, KEY_MAP, resolve_keys } from '../../src/lib/structure/terminal-capture'

describe('strip_ansi', () => {
  it('removes CSI color codes', () => {
    expect(strip_ansi('\x1b[31mred\x1b[0m')).toBe('red')
  })
  it('removes OSC sequences (e.g. OSC 7 cwd)', () => {
    expect(strip_ansi('a\x1b]7;file://h/p\x07b')).toBe('ab')
  })
  it('keeps plain text and newlines', () => {
    expect(strip_ansi('line1\nline2')).toBe('line1\nline2')
  })
})

describe('next_marker', () => {
  it('is unique per call and matches the expected shape', () => {
    const a = next_marker(); const b = next_marker()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^__CATGO_\d+_[a-z0-9]+__$/)
  })
})

describe('wrap_command / extract_result', () => {
  it('round-trips output and exit code (simulating shell echo + run)', () => {
    const marker = '__CATGO_1_abc__'
    const wrapped = wrap_command('echo hi', marker)
    // The shell echoes the wrapped command (contains %s_BEGIN, marker in quotes),
    // then prints the real BEGIN/output/END.
    const raw = wrapped + `\r\n` +
      `\n${marker}_BEGIN\n` + `hi\n` + `\n${marker}_END_0\n` + `(base) $ `
    const res = extract_result(strip_ansi(raw), marker)
    expect(res).toEqual({ output: 'hi', exit_code: 0 })
  })
  it('returns null until END marker is present', () => {
    const marker = '__CATGO_2_def__'
    const raw = `\n${marker}_BEGIN\n` + 'partial output'
    expect(extract_result(raw, marker)).toBeNull()
  })
  it('captures a non-zero exit code', () => {
    const marker = '__CATGO_3_ghi__'
    const raw = `\n${marker}_BEGIN\n` + 'nope\n' + `\n${marker}_END_2\n`
    expect(extract_result(raw, marker)).toEqual({ output: 'nope', exit_code: 2 })
  })
  it('is not fooled by the echoed command (literal %s_BEGIN, quoted marker)', () => {
    const marker = '__CATGO_4_jkl__'
    const echo = `{ printf '\\n%s_BEGIN\\n' '${marker}'\necho hi\nprintf '\\n%s_END_%d\\n' '${marker}' "$?"\n}`
    const raw = echo + `\n${marker}_BEGIN\n` + 'hi\n' + `\n${marker}_END_0\n`
    expect(extract_result(raw, marker)).toEqual({ output: 'hi', exit_code: 0 })
  })
})

describe('resolve_keys', () => {
  it('maps named keys to control bytes and passes literal text through', () => {
    expect(resolve_keys('y<enter>')).toBe('y\r')
    expect(resolve_keys('<c-c>')).toBe('\x03')
    expect(resolve_keys('<up><tab><esc>')).toBe('\x1b[A\t\x1b')
    expect(resolve_keys('plain')).toBe('plain')
  })
  it('exposes the key table', () => {
    expect(KEY_MAP['<enter>']).toBe('\r')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/terminal-capture.test.ts`
Expected: FAIL — "Failed to resolve import ... terminal-capture" / functions undefined.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/structure/terminal-capture.ts
/**
 * Pure helpers for CatBot terminal control: ANSI stripping, command-output
 * markers (BEGIN..END_<exit>), and named-key resolution. No DOM / no PTY here —
 * keeps the logic unit-testable in isolation.
 */

/** Strip ANSI/VT control sequences (CSI, OSC, and stray C0 controls except \n\t). */
export function strip_ansi(s: string): string {
  return s
    // OSC: ESC ] ... BEL  or  ESC ] ... ST(ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... final byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Other ESC-prefixed singles / 2-char
    .replace(/\x1b[@-Z\\-_]/g, '')
    // Lone carriage returns (xterm line discipline) and remaining C0 except \n \t
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

let _seq = 0
/** Unique per-call marker token. */
export function next_marker(): string {
  _seq += 1
  const rand = Math.random().toString(36).slice(2, 10)
  return `__CATGO_${_seq}_${rand}__`
}

/**
 * Wrap a user command in a brace group that prints BEGIN before and
 * END_<exit-code> after. Newlines (not `;`) separate the parts so multi-word /
 * piped commands pass through verbatim; `$?` is the user command's exit code.
 */
export function wrap_command(cmd: string, marker: string): string {
  return `{ printf '\\n%s_BEGIN\\n' '${marker}'\n${cmd}\nprintf '\\n%s_END_%d\\n' '${marker}' "$?"\n}\r`
}

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the captured output between `MARKER_BEGIN` and `MARKER_END_<code>` in the
 * accumulated (ANSI-stripped) PTY text. Returns null until the END marker lands.
 * The echoed command can't false-match: its literal text is `%s_BEGIN` and the
 * marker there is quote-wrapped, never `MARKER_BEGIN` / `MARKER_END_<digits>`.
 */
export function extract_result(raw: string, marker: string): { output: string; exit_code: number | null } | null {
  const begin = `${marker}_BEGIN`
  const bi = raw.indexOf(begin)
  if (bi < 0) return null
  const after = raw.slice(bi + begin.length)
  const m = after.match(new RegExp(`${escape_re(marker)}_END_(\\d+)`))
  if (!m || m.index === undefined) return null
  const output = after.slice(0, m.index).replace(/^\n+/, '').replace(/\n+$/, '')
  return { output, exit_code: parseInt(m[1], 10) }
}

/** Named-key tokens → control bytes. Literal text passes through unchanged. */
export const KEY_MAP: Record<string, string> = {
  '<enter>': '\r',
  '<tab>': '\t',
  '<esc>': '\x1b',
  '<backspace>': '\x7f',
  '<space>': ' ',
  '<up>': '\x1b[A',
  '<down>': '\x1b[B',
  '<right>': '\x1b[C',
  '<left>': '\x1b[D',
  '<c-c>': '\x03',
  '<c-d>': '\x04',
  '<c-z>': '\x1a',
}

/** Replace `<...>` tokens with their bytes; everything else is literal. */
export function resolve_keys(keys: string): string {
  return keys.replace(/<[a-z-]+>/gi, (tok) => KEY_MAP[tok.toLowerCase()] ?? tok)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/terminal-capture.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/terminal-capture.ts tests/vitest/terminal-capture.test.ts
git commit -m "feat(terminal-tools): pure capture helpers (markers, ansi strip, key map)"
```

---

## Task 2: Terminal registry (`terminal-registry.svelte.ts`)

**Files:**
- Create: `src/lib/structure/terminal-registry.svelte.ts`
- Test: `tests/vitest/terminal-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/terminal-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  register_terminal, unregister_terminal, mark_terminal_active,
  get_active_terminal, has_active_terminal, _reset_registry_for_test,
  type TerminalHandle,
} from '../../src/lib/structure/terminal-registry.svelte'

function fake(id: string): TerminalHandle {
  return {
    id, session_id: '', is_remote: false,
    run_command: async () => ({ output: '', exit_code: 0, running: false }),
    send_keys: async () => {}, interrupt: async () => {}, read_buffer: () => '',
  }
}

describe('terminal-registry', () => {
  beforeEach(() => _reset_registry_for_test())

  it('reports no active terminal when empty', () => {
    expect(has_active_terminal()).toBe(false)
    expect(get_active_terminal()).toBeNull()
  })
  it('returns the explicitly-activated handle', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('b')
    expect(get_active_terminal()?.id).toBe('b')
  })
  it('falls back to the most-recently registered when active id is stale', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('b')
    unregister_terminal('b')
    expect(get_active_terminal()?.id).toBe('a')
  })
  it('unregister of a non-active handle keeps the active one', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('a')
    unregister_terminal('b')
    expect(get_active_terminal()?.id).toBe('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/terminal-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/structure/terminal-registry.svelte.ts
/**
 * In-process registry bridging CatBot tools <-> the visible terminal PTYs.
 * Each TerminalPanel registers a handle on mount and marks itself active on
 * focus; CatBot tools call get_active_terminal(). Renderer-global singleton —
 * in a popout window it is that window's own registry (window-local, like the
 * CWD-sync rule). No Svelte $state needed: callers read at call time, not in a
 * reactive context.
 */

export interface TerminalHandle {
  id: string
  session_id: string // '' for local, HPC session id for remote
  host?: string
  username?: string
  is_remote: boolean
  run_command: (cmd: string, opts?: { timeout_ms?: number }) =>
    Promise<{ output: string; exit_code: number | null; running: boolean }>
  send_keys: (data: string) => Promise<void>
  interrupt: () => Promise<void>
  read_buffer: (lines?: number) => string
}

const _handles = new Map<string, TerminalHandle>()
const _order: string[] = [] // registration order; last = most recent
let _active_id: string | null = null

export function register_terminal(h: TerminalHandle): void {
  _handles.set(h.id, h)
  const i = _order.indexOf(h.id)
  if (i >= 0) _order.splice(i, 1)
  _order.push(h.id)
}

export function unregister_terminal(id: string): void {
  _handles.delete(id)
  const i = _order.indexOf(id)
  if (i >= 0) _order.splice(i, 1)
  if (_active_id === id) _active_id = null
}

export function mark_terminal_active(id: string): void {
  if (_handles.has(id)) _active_id = id
}

export function get_active_terminal(): TerminalHandle | null {
  if (_active_id && _handles.has(_active_id)) return _handles.get(_active_id)!
  for (let i = _order.length - 1; i >= 0; i--) {
    const h = _handles.get(_order[i])
    if (h) return h
  }
  return null
}

export function has_active_terminal(): boolean {
  return get_active_terminal() !== null
}

/**
 * App registers an opener so the tools can auto-spawn a local terminal when none
 * exists. Returns the new handle once it has registered.
 */
let _opener: (() => Promise<TerminalHandle | null>) | null = null
export function set_terminal_opener(fn: (() => Promise<TerminalHandle | null>) | null): void {
  _opener = fn
}
export async function ensure_active_terminal(): Promise<TerminalHandle | null> {
  const existing = get_active_terminal()
  if (existing) return existing
  if (_opener) return await _opener()
  return null
}

/** Test-only: clear all state. */
export function _reset_registry_for_test(): void {
  _handles.clear()
  _order.length = 0
  _active_id = null
  _opener = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/terminal-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/terminal-registry.svelte.ts tests/vitest/terminal-registry.test.ts
git commit -m "feat(terminal-tools): in-process terminal registry + auto-spawn opener hook"
```

---

## Task 3: TerminalPanel methods + registration

**Files:**
- Modify: `src/lib/structure/TerminalPanel.svelte` (script: add methods; register in the existing pty effect; unregister on cleanup)

Context: `pty_ref` (a `$state<PtySession | null>`) is set after `spawnPty` (~line 523); the OSC 7 injection effect at ~line 78 gates on `pty_ref`. `session_id`, `host`, `username` are props. `container_el`/xterm `term` are created in the main effect; capture `term` into a module ref for `read_buffer`.

- [ ] **Step 1: Add imports + a term ref**

At the top of `<script>` (with the other imports):

```ts
  import { register_terminal, unregister_terminal, mark_terminal_active } from './terminal-registry.svelte'
  import { next_marker, wrap_command, extract_result, strip_ansi } from './terminal-capture'
```

Find the existing `let term_ref: any = null` (already present per the file). If absent, add it near `let pty_ref`.

- [ ] **Step 2: Add the four methods + a busy guard**

Add inside `<script>` (after `pty_ref` is declared):

```ts
  let _run_busy = false

  async function panel_run_command(
    cmd: string,
    opts?: { timeout_ms?: number },
  ): Promise<{ output: string; exit_code: number | null; running: boolean }> {
    const pty = pty_ref
    if (!pty) return { output: 'Terminal not ready.', exit_code: null, running: false }
    if (_run_busy) return { output: 'Terminal is busy running another command.', exit_code: null, running: false }
    _run_busy = true
    const marker = next_marker()
    const decoder = new TextDecoder()
    let acc = ''
    let off: (() => void) | null = null
    try {
      const done = new Promise<{ output: string; exit_code: number | null; running: boolean }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ output: strip_ansi(acc).slice(-4000), exit_code: null, running: true })
        }, opts?.timeout_ms ?? 15000)
        off = pty.onData((bytes) => {
          acc += decoder.decode(bytes, { stream: true })
          const res = extract_result(strip_ansi(acc), marker)
          if (res) {
            clearTimeout(timeout)
            resolve({ output: res.output.slice(-8000), exit_code: res.exit_code, running: false })
          }
        })
      })
      await pty.write(wrap_command(cmd, marker))
      return await done
    } finally {
      if (off) off()
      _run_busy = false
    }
  }

  async function panel_send_keys(data: string): Promise<void> {
    if (pty_ref) await pty_ref.write(data)
  }

  async function panel_interrupt(): Promise<void> {
    if (pty_ref) await pty_ref.write('\x03')
  }

  function panel_read_buffer(lines = 40): string {
    const term = term_ref
    if (!term?.buffer?.active) return ''
    const buf = term.buffer.active
    const end = buf.baseY + buf.cursorY
    const start = Math.max(0, end - lines)
    const out: string[] = []
    for (let y = start; y <= end; y++) {
      const line = buf.getLine(y)
      if (line) out.push(line.translateToString(true))
    }
    return out.join('\n').replace(/\n+$/, '')
  }
```

- [ ] **Step 3: Register the handle in the pty effect; mark active on focus; unregister on cleanup**

In the existing OSC-7 `$effect` (the one guarded by `if (!pty_ref) { ... return }`), after confirming `pty_ref` exists, register once. Add a module flag `let _registered = false` near `let _osc7_injected = false`, then inside that effect's `if (!pty_ref)` reset branch also do `if (_registered) { unregister_terminal(panel_id); _registered = false }`, and after the OSC7 injection setup add:

```ts
    if (!_registered) {
      _registered = true
      register_terminal({
        id: panel_id,
        session_id: session_id ?? '',
        host, username,
        is_remote: !!session_id,
        run_command: panel_run_command,
        send_keys: panel_send_keys,
        interrupt: panel_interrupt,
        read_buffer: panel_read_buffer,
      })
    }
```

Add a stable `panel_id` near the top of `<script>`:

```ts
  let _pid_seq = 0
  const panel_id = `term-panel-${++_pid_seq}-${Math.random().toString(36).slice(2, 8)}`
```

In the MAIN xterm effect, after `term.open(...)` (where `term` is created), add a focus listener to mark active:

```ts
    term.textarea?.addEventListener('focus', () => mark_terminal_active(panel_id))
```

And in that main effect's cleanup (the returned function / `disposed` path), add:

```ts
    unregister_terminal(panel_id)
    _registered = false
```

- [ ] **Step 4: Type-check**

Run: `pnpm check 2>&1 | tail -3`
Expected: `0 errors` (304 pre-existing warnings unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/TerminalPanel.svelte
git commit -m "feat(terminal-tools): TerminalPanel exposes run_command/send_keys/interrupt/read_buffer + registers handle"
```

---

## Task 4: CatBot terminal tools (`terminal-tools.ts`) + registration

**Files:**
- Create: `src/lib/chat/terminal-tools.ts`
- Modify: `src/lib/chat/structure-tools.ts` (register `TERMINAL_TOOLS` at the bottom, beside `VIEWER_TOOLS`)
- Test: `tests/vitest/terminal-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/terminal-tools.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { TERMINAL_TOOLS } from '../../src/lib/chat/terminal-tools'
import {
  register_terminal, _reset_registry_for_test, mark_terminal_active,
  type TerminalHandle,
} from '../../src/lib/structure/terminal-registry.svelte'

function find(name: string) {
  const t = TERMINAL_TOOLS.find((x) => x.def.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

const calls: string[] = []
function handle(): TerminalHandle {
  return {
    id: 'h', session_id: '', is_remote: false,
    run_command: async (cmd) => { calls.push('run:' + cmd); return { output: 'OUT', exit_code: 0, running: false } },
    send_keys: async (d) => { calls.push('keys:' + d) },
    interrupt: async () => { calls.push('interrupt') },
    read_buffer: () => 'BUFFER',
  }
}

describe('terminal tools', () => {
  beforeEach(() => { _reset_registry_for_test(); calls.length = 0; register_terminal(handle()); mark_terminal_active('h') })

  it('exposes the four tools with correct kinds', () => {
    expect(find('read_terminal').def.kind).toBe('read')
    expect(find('run_command').def.kind).toBe('mutate')
    expect(find('send_keys').def.kind).toBe('mutate')
    expect(find('interrupt_terminal').def.kind).toBe('mutate')
  })
  it('read_terminal returns the buffer', async () => {
    const r = await find('read_terminal').run({}) as { output: string }
    expect(r.output).toBe('BUFFER')
  })
  it('run_command forwards the command and returns output + exit_code', async () => {
    const r = await find('run_command').run({ command: 'pwd' }) as { output: string; exit_code: number }
    expect(calls).toContain('run:pwd')
    expect(r).toMatchObject({ output: 'OUT', exit_code: 0 })
  })
  it('send_keys resolves named keys before writing', async () => {
    await find('send_keys').run({ keys: 'y<enter>' })
    expect(calls).toContain('keys:y\r')
  })
  it('interrupt_terminal sends Ctrl-C', async () => {
    await find('interrupt_terminal').run({})
    expect(calls).toContain('interrupt')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/terminal-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/chat/terminal-tools.ts
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
      description: 'Run a non-interactive shell command in the active terminal pane and return its output + exit code. If output shows a prompt or `running` is true, the command may be waiting for input — use send_keys. Works for local and HPC terminals.',
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
```

- [ ] **Step 4: Register into the tool registry**

In `src/lib/chat/structure-tools.ts`, near the top imports add:

```ts
import { TERMINAL_TOOLS } from './terminal-tools'
```

At the very bottom, beside `for (const { def, run } of VIEWER_TOOLS) register(def, run)`, add:

```ts
for (const { def, run } of TERMINAL_TOOLS) register(def, run)
```

- [ ] **Step 5: Run tests + type-check**

Run: `pnpm vitest run tests/vitest/terminal-tools.test.ts && pnpm check 2>&1 | tail -3`
Expected: tools test PASS; `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/terminal-tools.ts src/lib/chat/structure-tools.ts tests/vitest/terminal-tools.test.ts
git commit -m "feat(terminal-tools): read_terminal/run_command/send_keys/interrupt_terminal CatBot tools"
```

---

## Task 5: Auto-spawn opener (App provides a local terminal when none active)

**Files:**
- Modify: `desktop/App.svelte` (register a `set_terminal_opener` that creates a local terminal leaf and waits for its handle)

Context: App holds `tab_states`, the active `ts` (StructureTabState), `escalateForImport`, `setLeafContent`. A terminal leaf renders `TerminalWindow` → `TerminalPanel`, which registers asynchronously after `spawnPty`. The opener must create the leaf, then poll `get_active_terminal()` until a handle appears (bounded).

- [ ] **Step 1: Add imports**

With App's other imports from `'./pane-tree'` / registry:

```ts
  import { set_terminal_opener, get_active_terminal, type TerminalHandle } from '$lib/structure/terminal-registry.svelte'
```

- [ ] **Step 2: Register the opener in an onMount/$effect**

Add (inside an existing `$effect(() => { ... })` that runs once on mount, or a new one):

```ts
  $effect(() => {
    set_terminal_opener(async (): Promise<TerminalHandle | null> => {
      const ts = get_active_ts()
      if (!ts) return null
      const r = escalateForImport(ts.root, ts.active_leaf_id)
      if (!r) return null
      ts.root = setLeafContent(r.root, r.leafId, { type: `terminal`, term: { sync_cwd: false } })
      ts.active_leaf_id = r.leafId
      // Wait (bounded) for the new TerminalPanel to spawn its PTY and register.
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 100))
        const h = get_active_terminal()
        if (h) return h
      }
      return null
    })
    return () => set_terminal_opener(null)
  })
```

`get_active_ts` is already destructured from `tm` in App.svelte:135 (`const { tab_states, get_active_ts, ... } = tm`).

- [ ] **Step 3: Type-check**

Run: `pnpm check 2>&1 | tail -3`
Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add desktop/App.svelte
git commit -m "feat(terminal-tools): auto-spawn a local terminal when CatBot has no active terminal"
```

---

## Task 6: "Ask CatBot" button (TerminalWindow header → chat split)

**Files:**
- Modify: `src/lib/structure/TerminalWindow.svelte` (add `🤖` button + `on_ask_catbot?` prop)
- Modify: `desktop/App.svelte` (pass `on_ask_catbot` into the terminal leaf body; implement split → `initial_panel='chat'`)

- [ ] **Step 1: Add the prop + button to TerminalWindow**

In `TerminalWindow.svelte` `Props`/`$props()` (where `onpopout`, `onclose` are), add `on_ask_catbot?: () => void`. In the destructure: `on_ask_catbot`.

In the `tw-toolbar-right` div, before the popout `↗` button, add:

```svelte
      {#if on_ask_catbot}
        <button class="tw-icon-btn" title={t('app.ask_catbot')} onclick={on_ask_catbot}>
          <Icon icon="Chat" />
        </button>
      {/if}
```

(`Chat` is a confirmed icon in `src/lib/icons.ts`. `Icon` and `t` are already imported in TerminalWindow.svelte.)

- [ ] **Step 2: Wire App to pass on_ask_catbot into the terminal body**

In `App.svelte`, find where the `terminal_body` snippet renders `<TerminalWindow ... />` (the one with `initial_session_id`, `onclose`, `onpopout`). Add:

```svelte
            on_ask_catbot={() => open_chat_beside(leaf)}
```

Add the helper near the other pane helpers:

```ts
  function open_chat_beside(leaf: LeafNode) {
    const ts = active_ts()
    if (!ts) return
    const r = escalateForImport(ts.root, leaf.id)
    if (!r) {
      // At CAP: fall back to the chat popout window.
      window.open(`${location.origin}${location.pathname}#chat`, '_blank', 'width=520,height=760')
      return
    }
    ts.root = r.root
    const new_leaf = findLeafById(ts.root, r.leafId)
    const pane = new_leaf ? structurePane(new_leaf) : null
    if (pane) pane.initial_panel = `chat`
    ts.active_leaf_id = r.leafId
  }
```

`get_active_ts`, `escalateForImport`, `structurePane` are already in App. Add `findLeafById` and the `LeafNode` type to App's `'./pane-tree'` import if not already present (App.svelte:62 imports several pane-tree symbols).

- [ ] **Step 3: Type-check**

Run: `pnpm check 2>&1 | tail -3`
Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/TerminalWindow.svelte desktop/App.svelte
git commit -m "feat(terminal-tools): Ask CatBot button opens a chat panel beside the terminal"
```

---

## Task 7: i18n keys (en + zh parity)

**Files:**
- Modify: `src/lib/i18n/en/app.ts`
- Modify: `src/lib/i18n/zh/app.ts`

- [ ] **Step 1: Add the key to en**

In `src/lib/i18n/en/app.ts`, in the Panel section (near `dir_sync_on`):

```ts
  ask_catbot: `Ask CatBot about this terminal`,
```

- [ ] **Step 2: Add the matching key to zh**

In `src/lib/i18n/zh/app.ts`, same section:

```ts
  ask_catbot: `让 CatBot 处理此终端`,
```

- [ ] **Step 3: Verify i18n parity + full suite**

Run: `pnpm vitest run 2>&1 | tail -5`
Expected: PASS, including any i18n key-parity test. (`pnpm check` also `0 errors`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/en/app.ts src/lib/i18n/zh/app.ts
git commit -m "i18n(terminal-tools): ask_catbot key (en+zh)"
```

---

## Task 8: Playwright integration test

**Files:**
- Create: `tests/e2e/catbot-terminal.spec.ts` (match the repo's existing Playwright test dir/naming — verify with `ls tests/e2e 2>/dev/null || grep -rl "@playwright/test" tests`)

Note: CatBot needs a configured provider to run the full tool-loop. If the e2e harness has no LLM key, assert the **tool layer** directly via `page.evaluate` against the registry + tools (deterministic, no model), which still exercises the real PTY + capture path.

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/catbot-terminal.spec.ts
import { test, expect } from '@playwright/test'

const BASE = process.env.CATGO_E2E_URL ?? 'http://localhost:3186'

test('run_command captures real terminal output via the registry', async ({ page }) => {
  await page.goto(BASE)
  // Open a local terminal from the landing grid.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      x.textContent?.includes('Terminal') && x.textContent?.includes('Local shell'))
    ;(b as HTMLButtonElement)?.click()
  })
  // Wait for a terminal handle to register.
  await page.waitForFunction(async () => {
    const m = await import('/@fs' + (window as any).__catgo_repo + '/src/lib/structure/terminal-registry.svelte.ts').catch(() => null)
    return !!m && m.has_active_terminal && m.has_active_terminal()
  }, { timeout: 15000 }).catch(() => {})

  // Drive the tool directly (deterministic, no LLM): import the registry and run a command.
  const out = await page.evaluate(async () => {
    const reg: any = await import('/src/lib/structure/terminal-registry.svelte.ts')
    const h = reg.get_active_terminal()
    if (!h) return 'NO_HANDLE'
    const r = await h.run_command('echo catgo_marker_123')
    return r.output
  })
  expect(out).toContain('catgo_marker_123')
})
```

If the dynamic `import('/src/...')` path differs under the dev server, resolve the served module URL the way `bond-wasm` verification did (`/@fs/<abs path>/...`); the assertion (output contains the echoed token) is unchanged.

- [ ] **Step 2: Run it against the dev server**

Run (dev stack already on :3186): `pnpm exec playwright test tests/e2e/catbot-terminal.spec.ts`
Expected: PASS — `out` contains `catgo_marker_123` (proves marker capture over a real local PTY).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/catbot-terminal.spec.ts
git commit -m "test(terminal-tools): e2e run_command captures real PTY output"
```

---

## Final verification

- [ ] `pnpm check` → `0 errors`.
- [ ] `pnpm vitest run` → all pass (capture, registry, tools, i18n parity).
- [ ] Manual smoke (browser :3186): open terminal → in CatBot ask "run pwd in my terminal" → approve the card → output returned; "Ask CatBot" button opens a chat panel beside the terminal; with no terminal open, a run_command auto-spawns one.
- [ ] Merge to `feat/pane-tree-core` (fast-forward from the worktree branch).

## Notes / invariants

- **No `src/lib/mobile/*` edits** (D8). `TerminalPanel` gains methods (shared), but the Ask-CatBot button is desktop-only and mobile makes no tool calls.
- **No backend changes** — all execution flows through the visible PTY.
- Project style by hand (single quote, no semicolon, 2-space). Never run `deno fmt`.
- **Approval / auto-run already exist**: `kind:'mutate'` triggers the PermissionCard (tool-loop.ts:160 → ChatPane `active_permission_blocks`), and the per-chat auto-run toggle is the existing `slice.skip_permission` (set_skip_permission/get_skip_permission, hint `chat.skip_permission_on`). No new approval UI for v1.
