# CatBot Slash Commands — Design

Date: 2026-05-17
Status: Approved (brainstorming), pending implementation plan

## Problem

CatBot (the in-app chat in `ChatPane.svelte`, talking to the Claude Agent
SDK via agent-bridge) has no slash-command system. High-frequency
deterministic operations — start a new session, clear history, stop
generation, resume a past session, quick-build an OER/HER/CO2RR/NRR
workflow, inject the current structure — currently require natural
language → LLM round-trip: slow, token-costly, non-deterministic.

Claude Code's own slash commands **cannot be inherited**. Verified
against `@anthropic-ai/claude-agent-sdk@0.2.87`: the adapter
(`src/lib/server/agent-bridge/adapters/claude.ts`) intentionally runs
`settingSources: []` (isolation mode) so `~/.claude/mcp.json` and other
global settings are not loaded. Enabling `settingSources:['project']` is
a coarse bundle (would also load global MCP servers + settings the
adapter deliberately avoids), and even then `.claude/commands/*.md` are
LLM prompt macros (token cost, LLM round-trip); built-in `/clear` etc.
are CLI-REPL-only and no-op via `query()`. `query().supportedCommands()`
exists for enumeration but requires the same non-empty `settingSources`.
Conclusion: the fast/zero-token deterministic layer must be a CatGo
client-side implementation.

## Goals

- Deterministic, zero-LLM-token, instant client-side slash commands in
  CatBot.
- Single source of truth so command list, `/help`, parsing, and
  autocomplete never drift (this session repeatedly fixed
  duplicated-and-drifted logic — structure_input 4 copies, reload-seq
  inline; the registry is the explicit countermeasure).
- Reuse existing chat-state exports, MCP recipes, and the durable
  current-structure store added earlier this session. No new backend.

## Non-Goals (YAGNI)

- LLM prompt-template commands (`/explain`, `/review-workflow`).
- User-defined / persisted custom commands.
- Inheriting Claude Code built-in or `.claude/commands/*.md` commands.

## Architecture

New module `src/lib/chat/slash-commands.ts` — one registry, one
entrypoint, no UI imports (testable in isolation).

```ts
interface SlashCtx {
  tab_id: string
  args: string                 // raw text after the command word
  // injected accessors (no direct UI/store imports in the registry):
  new_session(): void
  clear_chat_history(): void
  cancel_generation(): void
  resume_session(agent: string, session_id: string, messages?, tab_id?): void
  list_sessions(): SessionSummary[]
  load_session_messages(session_id: string): ChatMessage[]
  run_quickbuild(recipe: string, mp_id?: string): Promise<void>
  inject_structure(): Promise<void>
  set_skip_permission(on: boolean): void
  get_skip_permission(): boolean
  emit(msg: string): void      // push a local assistant-style note (no LLM, not persisted)
}

interface SlashCommand {
  name: string                 // "oer"
  aliases?: string[]
  hint: string                 // "[mp-id]" — for /help + autocomplete
  summary: string
  run(ctx: SlashCtx): Promise<void> | void
}

export const SLASH_COMMANDS: SlashCommand[]
export function match_slash(raw: string): { cmd: SlashCommand; args: string } | null
export async function run_slash(raw: string, ctx: SlashCtx): Promise<boolean> // false = not a command
```

### Dispatch

In `ChatPane.handle_send`, **before** the DOI branch and `send_message`:

```
trimmed msg
 └─ starts "/" ? ──no──> existing DOI / send_message path (byte-identical, unchanged)
     └─ match_slash ──no match──> ctx.emit("unknown command, try /help") ; return
         └─ run_slash(ctx) ; clear input ; return  (never reaches send_message)
```

Single interception point. `/` with no match → local error note, never
sent to the LLM. The non-`/` path is unchanged.

## Command Set (first version)

| Command | Args | Behavior |
|---|---|---|
| `/new` | — | `new_session()` — fresh session, clears current tab |
| `/clear` | — | `clear_chat_history()` — clears messages, keeps session |
| `/stop` | — | `cancel_generation()` — stops streaming |
| `/resume` | none → list; `<n>` → pick nth | none: list recent sessions, **each line = topic + last-message snippet (~60 chars) + relative time**, numbered; never raw IDs. `/resume 2` resumes the 2nd (reuses the localStorage message persistence added earlier this session) |
| `/oer` `/her` `/co2rr` `/nrr` | optional `mp-xxxx` | `run_quickbuild(recipe, mp_id?)` → `catgo_quickbuild` MCP. No mp-id → use the durable current-structure store. All four share one parameterised `run` (no per-recipe copies) |
| `/structure` | — | `inject_structure()` — fill the durable store structure into the current/selected Structure Input node; no structure → local note |
| `/skip-permission` | `on` / `off` / none=show state | session-scoped toggle (see Security) |
| `/help` | — | auto-generated from `SLASH_COMMANDS`, rendered locally, not sent to LLM |

- Case-insensitive, whitespace-tolerant.
- `/resume` list and `/help` use `ctx.emit()` (local assistant note —
  not LLM, not persisted to session storage).
- All commands reuse existing exports/MCP/store. No new backend.

## Security — /skip-permission

This disables the human approval gate for all non-CatGo tool calls
(Bash, SDK file writes, AskUserQuestion) for the rest of the chat
session. User explicitly chose session-wide scope, all non-CatGo tools.
Constraints to contain the risk:

- **State**: session-scoped reactive flag in `chat-state.svelte.ts` per
  `tab_id` — `slice.skip_permission.value` (`$state`, default `false`).
  **Not** persisted to localStorage — never survives reload or new
  session; a fresh session always re-gates.
- **Enforcement**: in `agent-bridge/adapters/claude.ts` `canUseTool`,
  after the existing CatGo-MCP auto-allow, if the per-stream
  skip-permission flag is `true`, auto-allow remaining tools
  (`{behavior:'allow'}`) instead of showing `PermissionCard`. The flag
  is read at `send_message` time and passed through `StreamParams` (new
  optional `skipPermissions?: boolean`) into the adapter closure,
  captured per-stream so a mid-stream toggle does not retroactively
  affect an in-flight round.
- **Commands**: `/skip-permission` shows state; `on` sets true and
  `ctx.emit`s a warning ("⚠️ Permission prompts disabled for this
  session — Bash and file tools will run without asking. /skip-permission
  off to re-enable."); `off` sets false.
- **Visibility (required)**: while true, a persistent banner renders in
  the ChatPane input area (reuse `input-hint-row`): "⚠️ skip-permission
  ON". Always visible so the gate-down state cannot be forgotten.
- `/new` resets the flag (new slice).
- Off by default, session-only, explicit opt-in, always visible. No
  global/persisted bypass, no per-tool allowlist file.

## Autocomplete

- **Trigger**: input text starts with `/` AND has no space yet (still
  typing the command name). A space → args phase, close. Not `/` →
  close.
- **Data source**: the same `SLASH_COMMANDS` registry. Prefix match on
  name + aliases, case-insensitive. No matches → close (no empty box).
- **Render**: dropdown floating above the input (input is at the
  bottom). Theme variables only, no hardcoded colors (PermissionCard
  lesson this session). Each row: `/name` + hint + summary; selected row
  highlighted.
- **Keyboard (main integration risk, called out)**: existing
  `handle_keydown` does Enter = send. When the dropdown is open, these
  keys must be intercepted **before** the send logic:
  - `↑`/`↓` move selection, do not send
  - `Tab` or `Enter` → fill selected `/​<name> ` (trailing space, keep
    focus, **do not send**)
  - `Esc` → close dropdown (do not clear input)
  - other keys type normally, list re-filters live
  - when the dropdown is closed, `handle_keydown` behaves exactly as
    now (Enter still sends)
- Mouse click on a row = same as Tab. After selection, focus stays in
  the input; the user types args or presses Enter to run.
- **State**: ChatPane-local `$state` — `slash_open`, `slash_filtered`,
  `slash_idx`; `$derived` from `input_text`. Component-level, not in
  chat-state.

## Error Handling

- `/` no match → local note + suggest `/help`. Not sent to LLM.
- Missing/invalid args (`/resume 99` out of range, `/oer badformat`) →
  local usage note; no throw, not sent to LLM.
- `run()` throws (quickbuild MCP failure etc.) → caught, `ctx.emit`s the
  error text; one command failing never breaks the input box.
- Command typed while streaming: `/stop` always works; other commands
  reuse the existing `pending_send` queueing added earlier this session
  (the command queues and runs when the round ends) — consistent with
  message behavior.

## Testing

- `slash-commands.ts` is pure functions + injected ctx → vitest unit
  tests: `match_slash` parsing (case/whitespace/alias/no-match), each
  command `run` calls the right stub, error paths `emit` without
  throwing. Repo already has `tests/vitest/`.
- ChatPane integration: `/` interception never reaches `send_message`;
  non-`/` path regression unchanged; autocomplete keyboard branch
  (Enter = select-when-open vs send-when-closed).

## Files (anticipated)

- `src/lib/chat/slash-commands.ts` (new) — registry + match + run.
- `src/lib/chat/chat-state.svelte.ts` — add `skip_permission` per-slice
  $state + getter/setter; `/new` resets it via new slice.
- `src/lib/chat/ChatPane.svelte` — dispatch in `handle_send`,
  autocomplete state + dropdown markup + keyboard interception, skip
  banner in `input-hint-row`.
- `src/lib/chat/sdk-stream.ts` + `agent-bridge/types.ts` +
  `agent-bridge/server.ts` + `agent-bridge/adapters/claude.ts` — thread
  `skipPermissions` through `StreamParams` to `canUseTool`.
- `tests/vitest/` — slash-commands unit tests.
