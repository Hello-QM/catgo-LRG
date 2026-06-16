# CatBot Terminal Control — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Branch target:** `feat/pane-tree-core` (terminal leaves already live here)

## Goal

Let the in-app AI Chat (**CatBot**) read the content of the user's visible terminal pane and operate in it — run commands, send keystrokes, interrupt — Cursor-agent style, with per-command approval. Works for both **local** shells and **HPC** (remote SSH) terminals. Also surface CatBot from a terminal via an **"Ask CatBot"** button.

## Non-goals (YAGNI)

- Multi-terminal management by the agent (pick/list/route among many terminals). v1 targets the single *active* terminal.
- Full real-time TUI streaming / a virtual screen for the model. v1 is run-and-capture + discrete keystroke sends + buffer snapshots.
- Shell-integration OSC injection (VS Code OSC 633 style). v1 uses inline output markers.
- Backend command execution. All execution flows through the **visible** PTY so shell state (cwd, env, conda/venv) is preserved.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Approval | **Approve each command** via the existing client-tool gate; passive reads need no approval. Per-chat **"auto-run"** toggle (reuses `skip_permission`). |
| Target terminal | The **active** terminal leaf/tab. **Auto-spawn** a local terminal if none is active. |
| Interaction scope | Read buffer + run-and-capture + **interactive keystrokes** (`send_keys`) + Ctrl-C (`interrupt`). |
| CatBot surfacing | **"Ask CatBot" button** in the terminal header → opens a chat panel in an adjacent split, targeting that terminal. |
| Capture mechanism | **In-process registry + inline output markers** (Approach A). |

## Architecture overview

```
ChatPane (CLIENT_TOOLS tool-loop)
   │  run_command / send_keys / interrupt / read_terminal
   ▼
terminal-tools.ts  ──register name+schema+kind──▶ CLIENT_TOOLS / execute_tool / tool_kind
   │  (execute → resolve active handle)
   ▼
terminal-registry.svelte.ts   ── active_id, handles ──
   ▲ register/unregister/markActive
   │
TerminalPanel.svelte  ── run_command()/send_keys()/interrupt()/read_buffer() over its PTY
```

Both CatBot and the terminal live in the same window (chat is a panel in a sibling pane). The registry is the in-process bridge; no `window` CustomEvent or backend hop needed.

## Components

### 1. Terminal registry — `src/lib/structure/terminal-registry.svelte.ts` (new, ~80 lines)

Module-level `$state` registry mapping a stable id → handle.

```ts
export interface TerminalHandle {
  id: string                 // unique per TerminalPanel instance
  session_id: string         // '' for local, HPC session id for remote
  host?: string
  username?: string
  is_remote: boolean
  run_command: (cmd: string, opts?: { timeout_ms?: number }) =>
    Promise<{ output: string; exit_code: number | null; running: boolean }>
  send_keys: (data: string) => Promise<void>
  interrupt: () => Promise<void>
  read_buffer: (lines?: number) => string
}

export function register_terminal(h: TerminalHandle): void
export function unregister_terminal(id: string): void
export function mark_terminal_active(id: string): void
export function get_active_terminal(): TerminalHandle | null
export function has_active_terminal(): boolean
```

- `active_id` is set by `mark_terminal_active`, called from `TerminalPanel` on xterm `focus` and when it becomes visible/active.
- `get_active_terminal()` returns the active handle, or falls back to the most-recently-registered if `active_id` is stale (handle gone).
- Registry is renderer-global (module singleton). In a popout window it is that window's own registry — chat in a popout drives that popout's terminals (consistent with the window-local CWD-sync rule).

### 2. Capture protocol — `TerminalPanel.svelte` additions

Add four methods, wired into the registry via `register_terminal` in an existing `$effect` (after `pty_ref` is set), `unregister_terminal` on cleanup.

**`run_command(cmd, { timeout_ms = 15000 })`:**
- Generate a per-call unique `marker = __CATGO_<n>_<rand>__` (module counter `n` + a random token; ordinary browser `Math.random`/`Date.now` are fine here — the workflow-script ban on them does not apply to app code).
- Write to PTY: `{ printf '\n%s_BEGIN\n' "<marker>"; <cmd>; printf '\n%s_END_%d\n' "<marker>" "$?"; }\r`
  (brace group so `$?` is the user command's exit code; leading `\n` isolates the BEGIN line.)
- Attach a temporary `pty.onData` accumulator; strip ANSI; scan for `<marker>_BEGIN` … `<marker>_END_<code>`.
- Resolve `{ output, exit_code, running:false }` when END seen. On timeout, detach and resolve `{ output: <partial>, exit_code:null, running:true }` (command may be long or awaiting input).
- Guard: one in-flight `run_command` per panel; a second call rejects with a clear "terminal busy" error.
- ANSI strip + marker-line removal shared with a small helper (`strip_ansi`, `extract_between_markers`) — unit-testable, lives in `terminal-capture.ts`.

**`send_keys(data)`:** `pty.write(data)` raw. Caller passes already-resolved bytes (see tool schema key map). Returns after a short settle so a follow-up `read_buffer` reflects the result.

**`interrupt()`:** `pty.write('\x03')` (Ctrl-C).

**`read_buffer(lines = 40)`:** read the xterm buffer (`term.buffer.active`) bottom `lines` rows, join, right-trim. Returns plain text (already de-ANSI'd by xterm's buffer API).

### 3. CatBot tools — `src/lib/chat/terminal-tools.ts` (new) + register into `structure-tools.ts`

Register four tools into `CLIENT_TOOLS`, classify in `tool_kind`, dispatch in `execute_tool` (or a `terminal-tool-executor.ts` the dispatcher calls, mirroring the workflow-tool-executor split).

| Tool | Input | Approval | Returns |
|---|---|---|---|
| `read_terminal` | `{ lines?: number }` | none (passive) | current buffer text + `{session, host}` |
| `run_command` | `{ command: string }` | **yes** | `{ output, exit_code, running }` |
| `send_keys` | `{ keys: string }` — text and/or named keys (`<enter>`, `<up>`, `<tab>`, `<esc>`, `<c-c>`, `<c-d>`) | **yes** | buffer snapshot after settle |
| `interrupt_terminal` | `{}` | **yes** | buffer snapshot after settle |

- `send_keys` maps named tokens → control bytes via a small table in `terminal-tools.ts` (`<enter>`→`\r`, `<c-c>`→`\x03`, arrows→CSI, etc.); literal text passes through.
- **Auto-spawn:** if `get_active_terminal()` is null when `run_command`/`send_keys`/`interrupt`/`read_terminal` is called, the executor opens a local terminal leaf first (via the same path the "Terminal" landing card uses), waits for it to register, then proceeds. Surfaced to the model as a note ("opened a local terminal").
- Tool descriptions tell the model: prefer `run_command` for non-interactive commands; when output shows a prompt or `running:true`, use `send_keys`/`interrupt`; call `read_terminal` to inspect current state.

### 4. Approval — reuse the existing client-tool gate

- `run_command`, `send_keys`, `interrupt_terminal` are marked **mutating** in `tool_kind` so the existing in-browser gating (chat-state `run_tool_loop`, the mutating-CLIENT_TOOLS path) shows a confirm/PermissionCard before execution.
- The card shows the tool + the exact command/keys. Allow / Deny.
- Per-chat **"auto-run"** uses the existing `skip_permission` slice flag (a toggle in the chat header); when on, the gate is bypassed for that chat only, never persisted.
- Denied → tool returns a `denied` result string; the model adapts.

### 5. "Ask CatBot" button — `TerminalWindow.svelte` header + `App.svelte`

- Add a `🤖 Ask CatBot` `tw-icon-btn` to TerminalWindow's right toolbar.
- onclick → callback prop `on_ask_catbot` (App provides it). App: `splitLeaf` the current terminal leaf (direction `h`), set the new leaf's pane `initial_panel = 'chat'` (the existing AI-Chat panel mechanism), and `mark_terminal_active` for the source terminal so the chat targets it.
- If at CAP (4 leaves), fall back to opening the chat popout (`#chat`) instead of splitting.
- Mobile: **do not** add this button to mobile terminal UI (`src/lib/mobile/*` untouched — D8). The shared `TerminalPanel` registry methods are harmless on mobile (no tools call them there).

## Data flow — run a command

1. Model emits `run_command({command:"pwd"})`.
2. tool-loop → mutating gate → PermissionCard → user **Allow**.
3. `execute_tool` → `get_active_terminal()` (auto-spawn if none) → `handle.run_command("pwd")`.
4. TerminalPanel writes the marker-wrapped command to its PTY; `onData` accumulates until `<marker>_END_<code>`.
5. Returns `{ output:"/home/james/...", exit_code:0, running:false }` to the model.
6. Model reads the result and continues (e.g. on a `[y/N]` prompt, calls `send_keys({keys:"y<enter>"})`).

## Error handling / edge cases

- **No active terminal:** auto-spawn local, then proceed.
- **Capture timeout:** return partial output + `running:true`; model uses `read_terminal`/`send_keys`/`interrupt`.
- **Terminal busy** (overlapping `run_command`): reject with a clear message; model waits or interrupts.
- **HPC terminal:** identical path; markers travel over the SSH PTY. (HPC login banners/MOTD already settle before OSC 7 injection, so markers are not confused with banner text.)
- **Marker collision** with command output: marker includes a per-call random token; END requires the exact token + numeric code.
- **Panel unmount mid-run:** `unregister_terminal` + in-flight promise rejects ("terminal closed").
- **Popout window:** chat targets that window's own terminals (window-local registry).

## Testing

- **Unit (vitest):**
  - `terminal-capture.ts`: `strip_ansi`, `extract_between_markers` (BEGIN/END, exit-code parse, partial/no-END, marker not in output).
  - `terminal-registry`: register → active → get → unregister → fallback-to-recent.
  - `terminal-tools` key map: `<enter>`/`<c-c>`/arrows → bytes; literal passthrough.
- **Integration (Playwright):**
  - Open terminal → CatBot `run_command pwd` → approve → assert output contains cwd.
  - `run_command` of a command that prompts (`read -p`) → `send_keys` answers it → assert effect.
  - No-terminal-open → `run_command` auto-spawns then runs.
  - "Ask CatBot" button → opens a chat panel split next to the terminal.

## File summary

| File | Change |
|---|---|
| `src/lib/structure/terminal-registry.svelte.ts` | **new** — registry + active tracking |
| `src/lib/structure/terminal-capture.ts` | **new** — marker wrap/parse, ANSI strip (pure, tested) |
| `src/lib/structure/TerminalPanel.svelte` | add `run_command`/`send_keys`/`interrupt`/`read_buffer`; register/unregister |
| `src/lib/chat/terminal-tools.ts` | **new** — 4 tool schemas + key map |
| `src/lib/chat/terminal-tool-executor.ts` | **new** — dispatch + auto-spawn |
| `src/lib/chat/structure-tools.ts` | register terminal tools into `CLIENT_TOOLS`/`tool_kind`/`execute_tool` |
| `src/lib/structure/TerminalWindow.svelte` | `Ask CatBot` header button + `on_ask_catbot` prop |
| `desktop/App.svelte` | provide `on_ask_catbot` → split + `initial_panel='chat'`; auto-spawn helper |
| `src/lib/i18n/{en,zh}/*.ts` | keys: `ask_catbot`, approval card labels, auto-run toggle |
| `*/__tests__/*` | unit + Playwright tests above |

## Invariants honored

- No `src/lib/mobile/*` edits (D8); shared `TerminalPanel` gains methods but mobile adds no Ask-CatBot button and makes no tool calls.
- All command execution flows through the visible PTY (no hidden backend shell).
- Mutating tools always gated unless the user opts into per-chat auto-run.
- Project style by hand (single-quote, no-semicolon, 2-space); never run `deno fmt`.
