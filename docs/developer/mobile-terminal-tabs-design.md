# Design: Mobile terminal tabs ("Terminals" panel)

**Status:** Accepted — v1 scope locked, ready to implement
**Date:** 2026-06-07 · revised after a 3-agent review (codebase fact-check, architecture, mobile-UX); open questions resolved with the mentor
**Branch context:** builds on `ios-app` (mobile WKWebView app)
**Author/reviewers:** Jen + mentor

> **Revision note.** This v2 incorporates a multi-agent review. Changes from v1:
> corrected `channel_id` type and the xterm renderer claim, fixed the keep-warm
> facts (the terminal pane is *not* yet kept warm), added the critical
> `{#each}`-not-`{#if}` rendering rule, a registry-module decision, a lifecycle
> state machine, focus/keyboard handling, a width-responsive phone-vs-iPad
> layout, cwd-based labels, and answered several open questions with defaults.

---

## 1. Summary

Give the mobile app **tabbed terminals**. Today the mobile workspace
shows a single terminal (`MobileTerminal.svelte`, one PTY). This adds a UI to run
**multiple independent terminals**, **add** new ones, and **tap to switch** which
one is active in the main pane. Each tab is its own shell session — one might be
running Claude Code, another a job, another file work — and they stay alive in
the background, like the tabs in a desktop terminal app.

> "Claude chats" in the original sketch was an *example* of what a tab might be
> running, not a special binding. No Claude-resume, no tmux requirement.

### Out of scope (explicitly, v1)

- No tmux integration (a user may run tmux inside a tab; the app neither knows
  nor cares).
- No "resume a specific Claude conversation" binding.
- No multi-host clusters (one host at a time — §6.1).
- No reconnect cwd-restore, no custom rename (deferred — §6).

---

## 2. Concept / UX

The original sketch drew a **left vertical sidebar**. Per the UX review, that's a
good fit on the **iPad** (lots of width) but a poor one on the **phone** (a left
rail steals the scarce horizontal dimension that the terminal's column count
depends on — `FitAddon` derives `cols` from the content width). So the layout is
**width-responsive** (a CSS breakpoint, *not* device sniffing):

**Phone (compact width): a horizontal tab strip**
```
┌──────────────────────────────────────┐
│  top bar / action bar                 │
├──────────────────────────────────────┤
│ [proj-a][train][ + ]   ← scrollable   │   ← tab strip: short, wide, ~40px tall
├──────────────────────────────────────┤
│                                       │
│              Terminal                 │   ← active tab fills full width
│            (active tab)               │
│                                       │
├──────────────────────────────────────┤
│  key bar (soft-keyboard helpers)      │
└──────────────────────────────────────┘
```

**iPad (≥ tablet width): the persistent vertical sidebar from the sketch**
```
┌─[Terminals]──────────────────────────┐
│ ┌─────────┐ ┌──────────────────────┐ │
│ │ proj-a  │ │                      │ │
│ ├─────────┤ │       Terminal       │ │
│ │ train   │ │     (active tab)     │ │
│ ├─────────┤ │                      │ │
│ │  + add  │ │                      │ │
│ └─────────┘ └──────────────────────┘ │
└──────────────────────────────────────┘
```

- **Active tab** is highlighted (reuse the existing `.active` accent in
  `MobileWorkspace.svelte`).
- **Tab label = cwd basename** (e.g. `proj-a`), falling back to `Terminal N`
  until the first prompt arrives. The cwd is already captured per terminal via
  OSC 7 (`MobileTerminal.svelte` `on_cwd`). Three tabs reading "Terminal 1/2/3"
  are useless on a phone — the basename is what makes tabs tell-apart-able.
- **Add** (`+`) is a dedicated control at the end of the strip/list, visually
  distinct from tabs, ≥44px target. Disabled once the cap is hit (§6 Q2).
- **Switch:** tap a tab → it becomes active; the previous one keeps running.
- **Close:** tap = switch *always*. Closing is offered **two ways** (decided):
  (a) **long-press a tab → action sheet** ("Close terminal"), and (b) an
  **edit mode** toggle that reveals an ✕ badge on every tab (iOS-homescreen
  pattern) for closing several quickly. Keeping the default tap = switch means no
  always-on ✕ to mis-tap.
- **Closing the last tab** auto-spawns a fresh one — you always have ≥1 terminal
  (no "live session, no pane" dead-end).
- **Cap: 5 terminals** (decided). The `+` control is disabled once 5 are open.

### Toggle & naming

- **Toggle home:** do **not** add a toggle to `.mw-actions` — it already
  overflows with up to 6 buttons (`MobileWorkspace.svelte` `.mw-actions` is an
  `overflow-x:auto` scroller). On the **phone** the strip is simply present
  whenever the terminal is visible (no toggle needed). On the **iPad** the
  sidebar is persistent. If the mentor still wants an explicit collapse control,
  scope it to the terminal pane's own chrome, not the global action bar.
- **Naming (decided): "Terminals."** The app already uses "cluster" to mean an
  HPC host everywhere user-facing (connect flow, "open from cluster", SFTP), so a
  "Cluster" button that switches *shells* would read as if it switches *hosts*.
  The panel is therefore named **"Terminals"**, and **"Cluster" is reserved** for
  the future multi-host switcher (§3), where each entry genuinely *is* a cluster.

---

## 3. Data model

A small **terminal registry** — module-level reactive state so it survives
component remounts (same lifetime model as `sessions.ts`, which is module-level
for exactly this reason). It lives in a new **`src/lib/mobile/terminal_tabs.svelte.ts`**
(the `.svelte.ts` extension is the Svelte 5 idiom that allows `$state` at module
scope).

```ts
// terminal_tabs.svelte.ts
export type TermTab = {
  id: string                 // stable local id
  label: string              // cwd basename, or "Terminal N" until first prompt
  channel_id: string | null  // PTY channel id (UUID string), null until opened
  cwd: string                // last-known cwd (from OSC 7 / on_cwd)
  status: 'opening' | 'live' | 'disconnected'
  created_at: number
}
```

- **Keyed by `session_id`** so the list naturally resets when you disconnect /
  connect to a different host. `session_id` arrives via `MobileConnect`'s
  `on_connected` callback in `MobileWorkspace.svelte`; `disconnect()` flushes the
  registry.
- The registry stores **only serializable metadata**. The xterm.js `Terminal`
  instance and PTY callbacks stay inside each `MobileTerminal`'s `$effect`
  closure, as they are today — **never** store a `Terminal` in module state (it's
  DOM-tied; storing it leaks and blocks GC after close).
- Background tabs **stay alive**: each holds its own open PTY `channel_id`. The
  russh connection is multiplexed — the Rust side holds
  `ptys: Mutex<HashMap<String, PtyHandle>>` per session (`src-tauri/src/ssh/state.rs`),
  so N tabs = N independent channels over the *one* authenticated connection (no
  extra OTP, no extra TCP). Note: `ptyOpen` and `exec` briefly share the session
  `handle` mutex, so opening many tabs in a tight burst serializes — fine
  sequentially, just don't fan out 5 `ptyOpen`s in parallel and expect
  concurrency.

### "Cluster" scope

For v1, **one cluster = the current connection/host**; the panel lists that
host's terminals. Multi-host ("different clusters") would make the registry
`Map<endpointKey, TermTab[]>` — deferred (Open Q1). There is **no PTY cap in the
Rust layer** (the map is unbounded), so any cap is enforced JS-side (§6 Q2).

---

## 4. Technical approach (grounded in the current code)

### What exists today

- `MobileTerminal.svelte` takes a single `session_id` prop, opens **one** PTY via
  `transport.ptyOpen(session, cols, rows, onData) → Promise<string>` (channel id
  is a **string** UUID), mounts one xterm.js, and bubbles cwd up via `on_cwd`
  (runtime OSC 7 handler ~`MobileTerminal.svelte:241`; the shell-side OSC 7 hook
  is injected by the `ptyWrite` at ~`:264`). A `ResizeObserver` (~`:197`) keeps
  the PTY grid synced. `ptyClose` runs in the `$effect` cleanup (~`:285`).
- **xterm renderer:** only `@xterm/addon-fit` is loaded — **no** canvas/WebGL
  addon — so xterm uses its **DOM renderer** here.
- The russh transport already supports many channels per session.

### The change

1. **Render all tabs at once, hide with CSS.** Render one `<MobileTerminal>` per
   `TermTab` inside `{#each tabs as tab (tab.id)}`, all mounted simultaneously.
   **Do NOT** gate them with `{#if tab.id === active_tab_id}` — that unmounts the
   component on every switch, firing its `$effect` cleanup and **closing the
   PTY**. Visibility is CSS-only on each tab's wrapper.
2. **Keep-warm CSS (must be added — it does not exist yet).** Today the terminal
   pane is hidden with the generic `.mw-pane.hidden { display:none }`; only the
   3D pane has the `visibility:hidden` override (`.mw-pane.mw-struct.hidden`).
   We must add the analogous override for inactive *tab wrappers* inside the
   terminal pane:
   ```css
   /* inactive tab: laid out but invisible — never display:none */
   .term-tab.inactive {
     visibility: hidden;
     position: absolute;
     inset: 0;
     pointer-events: none;
   }
   ```
   Why: with `display:none`, xterm's DOM renderer + `FitAddon` measure a
   zero-size box and the grid comes back wrong on return — the same *class* of
   hidden-pane bug as the 3D viewer (different mechanism: DOM measurement, not a
   zeroed canvas).
3. **Expose `refit()` from `MobileTerminal`.** `visibility:hidden` does **not**
   fire the `ResizeObserver` on WKWebView (the element keeps its computed size),
   so the parent must explicitly re-fit when a tab becomes visible.
   `MobileTerminal` needs to expose a `refit()` (via `bind:this` / a bound
   prop); the workspace calls `active_tab_ref?.refit()` right after switching.
4. **Focus in a trusted gesture.** On switch, call the incoming tab's
   `term.focus()` **synchronously inside the tap handler** — not in a reactive
   `$effect`. WKWebView only honors programmatic focus (which raises the soft
   keyboard) from a trusted user event; deferring it drops the keyboard on every
   switch.
5. **Registry + actions** in `terminal_tabs.svelte.ts`: `add()`, `close(id)`,
   `switch(id)`. (No `rename` in v1.)
6. **cwd fan-out.** Each `MobileTerminal`'s `on_cwd` updates its `tabs[i].cwd`.
   The workspace passes the **active** tab's cwd to `MobileFiles` —
   `const active_cwd = $derived(tabs.find(t => t.id === active_tab_id)?.cwd ?? '')`
   — instead of today's single `term_cwd`.
7. **i18n.** New strings go in `src/lib/i18n/en/mobile.ts` **and** `zh/mobile.ts`
   in parity (CLAUDE.md rule): panel label, "New terminal", "Close terminal",
   "Terminal {n}", "Disconnected". Use `<Icon>` SVG for `+`/✕ — never raw Unicode
   (iOS tofu-glyph gotcha).

### Lifecycle state machine

```
init ─▶ opening ─▶ live ─▶ disconnected ─▶ (reopening | closed)
```
- `close(id)` sets `channel_id = null` and calls `ptyClose`.
- A **session drop** transitions *all* tabs to `disconnected` and **zeroes their
  `channel_id` before teardown** — so no stale `ptyClose`/`ptyWrite` fires on a
  dead session, and a later reuse of the SSH session (`sessions.ts`) can't write
  to a stale channel.
- On reconnect, v1 opens a **fresh** PTY per tab (no cwd-restore — Open Q5).

---

## 5. Build sequence (proposed)

1a. **Registry module.** Create `terminal_tabs.svelte.ts` with `add/close/switch`
    and a single auto-created tab. **Vitest unit tests** (no DOM) — green before
    any component change.
1b. **Thread it through the workspace** for a *single* tab sourced from the
    registry. No visual change. Device-verify the PTY still works.
2.  **N tabs, keep-warm.** Render the `{#each}`, add the `.term-tab.inactive` CSS,
    wire `refit()` on show. Verify two terminals stay alive at once on-device.
3.  **Panel UI** — the tab strip (phone) / sidebar (iPad), `+ add`,
    tap-to-switch, **active highlight + cwd-basename labels** (these are
    correctness for usability, not polish).
4.  **Close** — long-press → action sheet → `ptyClose`; last-tab-respawn rule.
5.  **Polish & hardening** — empty/disconnected states, reconnect behavior,
    on-device **soft-keyboard focus audit** (focus stays up across switches),
    resource check at the cap.

Each step is device-testable: `TAURI_DEV_HOST=$(ipconfig getifaddr en0) pnpm tauri ios dev "<device>"`.

---

## 6. Decisions (v1 — resolved with the mentor)

All open questions are now settled:

1. **Scope:** **single-host.** One connection at a time; the panel lists that
   host's terminals. Multi-host (`Map<endpointKey, TermTab[]>`) is deferred —
   and is the future owner of the "Cluster" name.
2. **Tab cap:** **5.** The `+` control is disabled once 5 terminals are open
   (bounds N live PTYs + N xterm instances on the phone WebView).
3. **Labels:** **cwd basename, `Terminal N` fallback.** Custom rename deferred.
4. **Close gesture:** **both** — long-press → action sheet, **and** an edit-mode
   toggle with ✕ badges. Default tap = switch.
5. **Reconnect cwd-restore:** **no for v1** — reopen a fresh shell per tab.
6. **Naming:** **"Terminals"** (not "Cluster"); "Cluster" reserved for the future
   multi-host switcher (§2).
7. **Layout:** **width-responsive** — horizontal tab strip on the phone,
   persistent vertical sidebar on the iPad (CSS breakpoint, not device sniffing).

### Deferred to a future iteration (not v1)

Multi-host "clusters", custom tab rename, reconnect cwd-restore, tmux awareness,
any Claude-session binding.

---

## 7. Risks & mitigations

- **`{#if active}` instead of `{#each}`** → closes the PTY on every switch. *The*
  most likely first-implementation bug. Mitigation: §4.1 rule, all instances
  mounted, CSS-only visibility.
- **Hidden-pane grid corruption** → mitigated by the `visibility:hidden`
  keep-warm CSS (§4.2) + explicit `refit()` on show (§4.3).
- **Soft keyboard drops on switch** → mitigated by synchronous `term.focus()` in
  the tap handler (§4.4); note the `visualViewport` IME caveat already documented
  in `MobileWorkspace.svelte`.
- **Stale `ptyClose` after disconnect** → mitigated by zeroing `channel_id` on
  all tabs before teardown (§4 state machine).
- **Resource use at N tabs** → enforce the cap (4–5); xterm DOM instances + PTY
  channels are modest, but verify on-device at the cap.
- **i18n drift** → add en+zh keys in parity in the same change (§4.7).
- **Scope creep** ("cluster", "Claude chat", "tmux") → v1 is scoped to plain
  terminal tabs; everything else is deferred in §1 / §6.
