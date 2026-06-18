# Terminal Leaves (Subproject 2) — Design

**Date:** 2026-06-16
**Status:** Draft for review
**Depends on:** Subproject 1 (unified pane tree — merged to `feat/pane-tree-core` @ `f1f668c`).
**Scope:** Desktop workspace. **Mobile must not change (D8).**

---

## 1. Motivation

Subproject 1 made the desktop layout a recursive pane tree, but every leaf is a
`structure`. Users want terminals inside that tree: open a terminal next to a
structure, recursively split to up to 4 terminals, mix terminal + structure cells,
and have the top-level "Terminal" tab share the same splitting. This subproject
widens a leaf so it can hold a **terminal**, and retires the two parallel terminal
surfaces (the in-viewer side panel and `TerminalWindow`'s own split) in favor of the
one tree.

Delivers user asks: terminal split-to-4, multi-terminal tabs, structure-in-a-cell
alongside terminals. **Fullscreen/maximize is Subproject 4** (leaf zoom). The
explicit "split and pick the new cell's type" switcher is **Subproject 3**.

## 2. Decisions (locked with the user)

| # | Decision |
|---|----------|
| T1 | A leaf may be `structure` **or** `terminal`. `LeafContent` widens to a union. |
| T2 | A terminal leaf wraps **one existing `TerminalPanel`** (single terminal + session). The tree provides splitting; `TerminalWindow`'s internal binary split is **retired**. |
| T3 | Both the **structure tab tree** and the **top "Terminal" tab** use the same `PaneTree`. The Terminal tab's root initializes to a single terminal leaf. |
| T4 | The in-viewer **side-panel terminal** (`show_terminal`/`TerminalPanel` in shared `Structure.svelte`) is **removed** on desktop; terminals live only as tree leaves. |
| T5 | v2 "add terminal" entry points: the empty-leaf landing **"Terminal" card** converts that leaf to a terminal; the top **"+Terminal"** tab opens a terminal-root tab. (A split-then-choose-type switcher is deferred to Subproject 3.) |
| T6 | Leaf cap stays **4** (terminals are cheap/no-WebGL; revisit later if needed). |
| T7 | **Window-local CWD sync** (user request): a terminal's Directory Sync drives only its **own window's** file browser. Drop the cross-window `BroadcastChannel("catgo-terminal-cwd")`; keep the same-window `CustomEvent`. Popping out a terminal opens a **full app window** (own sidebar/file browser + per-terminal sync toggle), so each window has an independent file system and a popout never moves the origin window's files. |
| **D8** | **Mobile unchanged.** Verified: mobile uses `MobileWorkspace`'s own `.mw-term`, independent of `Structure.svelte`'s desktop side panel. |

## 3. Hard constraints

- **Mobile untouched (D8).** `MobileWorkspace.svelte` derives its own `show_terminal`
  and renders `.mw-term` (its own terminal pane); it does **not** use the desktop
  side-panel terminal in `Structure.svelte`. Removing the desktop side panel must be
  verified not to alter any mobile-reachable path; if `Structure.svelte`'s
  `show_terminal` is reachable on mobile, gate the removal to desktop. No edit to
  `src/lib/mobile/*`.
- **Keep-warm:** a terminal leaf in an inactive tab keeps its PTY **alive** and its
  xterm canvas warm (never `display:none`; never auto-kill on tab switch).
- **No new errors / behavior parity** for structure leaves — the guard-helper
  rollout must not change structure-leaf behavior from subproject 1.
- **`PaneState` and the structure-leaf path remain unchanged** in shape; only the
  union widens around them.

## 4. Model changes (`desktop/pane-tree.ts`)

```ts
export interface TerminalLeafState {
  session_id?: string   // HPC remote SSH session; omit for local shell
  host?: string         // remote display name
  username?: string     // remote display name
  shell?: string        // local shell id (e.g. 'powershell')
  sync_cwd: boolean      // sync CWD to Files panel
  cwd?: string          // last-known cwd (for label / popout)
}

export type LeafContent =
  | { type: 'structure'; pane: PaneState }
  | { type: 'terminal'; term: TerminalLeafState }
```

New helpers (centralize the union guard so consumers stay terse):

- `isStructureLeaf(leaf): boolean`
- `structurePane(leaf): PaneState | null` — `content.pane` for structure leaves, else `null`
- `isTerminalLeaf(leaf): boolean`
- `terminalState(leaf): TerminalLeafState | null`
- `create_terminal_leaf(opts?: Partial<TerminalLeafState>): LeafNode`
- `create_empty_leaf()` unchanged (still an empty **structure** leaf — the default).

`splitLeaf`/`removeLeaf`/`setRatio`/`escalateForImport`/`buildPreset`/`matchesPreset`
are content-agnostic and unchanged, except: `escalateForImport`/`findFirstEmptyLeaf`
treat only **empty structure** leaves as "empty" (a terminal leaf is never an import
target). `isEmptyLeaf` already encodes this (it returns false for non-structure
content once the union exists).

## 5. Guard rollout (the main cost)

Subproject 1 made `leaf.content.pane` always valid. The union breaks that. Every
desktop site that reads `leaf.content.pane` must route through `structurePane(leaf)`
and skip/no-op for terminal leaves:

- **pane-tree.ts**: `isEmptyLeaf` (terminal ≠ empty).
- **tab-manager**: badge count = structure-with-content **plus** terminal leaves
  (both count as "populated"); `update_tab_label` ignores terminal leaves for the
  formula, but a terminal-only tab labels as `Terminal`.
- **pane-manager `close_panel`/`handle_unload`**: terminal leaf closes directly
  (kill session, `removeLeaf`) with **no** save-confirm banner (that's structure-only).
- **App.svelte** ~15 structure-specific sites (SSE injectors, dirty-detect effect,
  `get_current_structure`, `apply_entry_to_pane`, plugin-hub, etc.): guard with
  `structurePane(leaf)`; terminal leaves are skipped.
- **drag-drop / sidebar / close-all / popout**: structure-import logic targets only
  structure leaves (`findFirstEmptyLeaf` already excludes terminals). Popout gains a
  terminal-leaf branch (reuse the existing terminal popout).

A table-driven audit (grep `\.content\.pane` across `desktop/`) enumerates every site
in the plan.

## 6. Terminal leaf rendering (`PaneTree.svelte` + App snippet)

PaneTree's leaf branch dispatches on `content.type`:
- `structure` → existing `leaf_body` snippet (unchanged).
- `terminal` → a new `terminal_body` snippet (passed from App, same pattern), which
  renders `<TerminalPanel show_header={false} session_id={term.session_id} host=…
  username=… shell=… sync_cwd={term.sync_cwd} font_size/font_family from
  terminal_font_state … on_open_file=… on_cwd_change=(c)=>term.cwd=c />`.

Chrome: the leaf header (dot/label/popout/close) is shared. For a terminal leaf:
- label = `host` (remote) or shell / `cwd` basename (local) — a `terminalLabel(term)`
  helper.
- popout → terminal popout (existing `popout-manager` terminal path), passing the
  session.
- close → kill PTY + `removeLeaf` (no save banner).

`TerminalPanel`'s own `show_header={false}` (it already supports this for embedding) —
the tree's leaf header replaces it.

## 7. Session lifecycle

- **Create**: `create_terminal_leaf` makes a leaf with no `session_id` (local) or a
  given HPC `session_id`. `TerminalPanel` lazily `spawnPty` on mount (its existing
  behavior). State stored back into `term` (cwd via `on_cwd_change`).
- **Close**: closing a terminal leaf calls `TerminalPanel`'s `ondisconnect` (kill PTY)
  then `removeLeaf`.
- **Inactive tab**: keep PTY alive; `TerminalPanel` stays mounted, off-screen, not
  `display:none` (per keep-warm). No kill on tab switch.
- **Popout**: reuse existing terminal popout window (URL `#terminal?session_id=…`),
  closing the leaf in the main tree (mirrors current popout behavior).
- **App teardown**: existing PTY cleanup paths apply per leaf.

## 8. Remove the desktop side-panel terminal (`Structure.svelte`)

- Remove `show_terminal` rendering of `TerminalPanel`, `side_panel_size`/
  `terminal_layout` side logic, and the toolbar/`initial_panel==='terminal'` triggers
  **on the desktop path**.
- **Verify (D8):** confirm no mobile-reachable code sets `initial_panel='terminal'` or
  toggles `show_terminal` such that the desktop side panel would render on mobile. If
  any exists, gate the removal behind `!isMobile()` (or remove only the desktop
  trigger). Mobile's `.mw-term` is independent and stays.
- The editor/preview/chat side panels in `Structure.svelte` are **out of scope** — only
  the terminal side panel is removed. (They may later migrate too, but not here.)

## 9. Top "Terminal" tab → pane tree

- `tab.type === 'terminal'`: instead of rendering `<TerminalWindow>`, its
  `tab_states[id]` is a normal `StructureTabState` whose `root` is a single terminal
  leaf (`create_terminal_leaf()`), rendered by the same `<PaneTree>`. The "+Terminal"
  tab-create path seeds this root.
- `TerminalWindow.svelte` is **retired** from the App render path (its multi-tab role
  is the app tab bar; its binary split is the tree). Leave the file in place if other
  importers remain (`WorkflowView.svelte`, `index.ts`) but remove its use as the
  terminal-tab body; clean up dead imports the migration makes unused.
- A terminal-root tab and a structure-root tab are now the same machinery; tab type
  only sets the initial root content + default label.

## 10. Testing

- **Unit (`pane-tree.test.ts`)**: `create_terminal_leaf`, `isTerminalLeaf`/
  `isStructureLeaf`/`structurePane`/`terminalState`, `isEmptyLeaf` returns false for a
  terminal leaf, `findFirstEmptyLeaf`/`escalateForImport` never target a terminal leaf.
- **Type-check**: `pnpm check` 0 errors (the union forces every `content.pane` site to
  be guarded — the compiler is the safety net).
- **Full suite** green (4039 baseline; no regressions).
- **Mobile (D8)**: `git diff <base> HEAD -- src/lib/mobile` empty; `MobileWorkspace`
  smoke unchanged.
- **Manual smoke** (`pnpm desktop:serve`): open a terminal leaf from the landing card;
  split structure|terminal mixes; recursive split to 4 terminals; close a terminal
  (PTY dies, sibling fills); switch tabs and back (terminal survives, CWD intact);
  popout a terminal; top "+Terminal" tab opens a terminal then splits.

## 11. Risks & mitigations

- **Guard churn across just-migrated files** — every `content.pane` site re-touched.
  *Mitigation:* the `structurePane()` helper makes each site a one-line guard; the
  union makes `pnpm check` enumerate all of them (no silent misses); a grep audit in
  the plan lists every site up front.
- **Keep-warm for terminals** — a hidden terminal must not lose its PTY or reflow to
  0×0. *Mitigation:* reuse the structure-leaf keep-warm approach (off-screen, not
  `display:none`); `TerminalPanel` already handles resize via FitAddon.
- **Side-panel removal touching shared `Structure.svelte`** — D8 risk. *Mitigation:*
  the §8 verification gate + desktop gating if any mobile path is reachable.
- **Retiring `TerminalWindow`** — other importers (`WorkflowView`, `index.ts`).
  *Mitigation:* only remove its use as the terminal-tab body; leave the component for
  remaining importers; remove only imports this change makes unused.

## 12. Out of scope

- Mobile (any change). Fullscreen/leaf-zoom (Subproject 4). Split-and-choose-type
  switcher + arbitrary leaf retype (Subproject 3). Open-file-destination setting
  (Subproject 5). Editor/preview/chat side panels in `Structure.svelte`. Raising the
  4-leaf cap.
