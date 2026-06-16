# Terminal Leaves (Subproject 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a pane-tree leaf hold a terminal (one `TerminalPanel`) as well as a structure, so terminals split/mix/maximize via the same tree; remove the desktop side-panel terminal and route the top "Terminal" tab through the tree.

**Architecture:** Widen `LeafContent` to `structure | terminal`. A `structurePane(leaf)` helper keeps the ~25 structure-only consumer sites terse, and the TS union makes `pnpm check` enumerate every one. PaneTree renders a terminal leaf via a new `terminal_body` snippet wrapping `TerminalPanel show_header={false}`. Session lifecycle: lazy spawn on mount, kill on close, keep-warm on inactive tab.

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest, xterm.js (`TerminalPanel`/`pty.ts`). No formatter available — write single-quote/no-semicolon/2-space by hand; never run `deno fmt`.

**Spec:** `docs/superpowers/specs/2026-06-16-terminal-leaves-design.md`. **Constraint D8:** no `src/lib/mobile/*` change; mobile uses `MobileWorkspace`'s `.mw-term`, independent of the removed desktop side panel.

**Build-red window:** Task 1 widens the union → `pnpm check` red until the guards land (Task 2) + render/tab work (Tasks 3,6,7). `pane-tree.test.ts` stays green throughout; full green at Task 8.

---

## Task 1: `desktop/pane-tree.ts` — widen `LeafContent` + terminal helpers (TDD)

**Files:** Modify `desktop/pane-tree.ts`; Test `tests/desktop/pane-tree.test.ts`.

- [ ] **Step 1.1: Failing tests** — append to `tests/desktop/pane-tree.test.ts`:

```ts
import {
  create_terminal_leaf, isStructureLeaf, isTerminalLeaf, structurePane, terminalState,
} from '../../desktop/pane-tree'

describe('terminal leaves', () => {
  it('create_terminal_leaf makes a terminal leaf with a unique id and given state', () => {
    const t = create_terminal_leaf({ shell: 'bash', sync_cwd: true })
    expect(t.kind).toBe('leaf')
    expect(isTerminalLeaf(t)).toBe(true)
    expect(isStructureLeaf(t)).toBe(false)
    expect(terminalState(t)?.shell).toBe('bash')
    expect(terminalState(t)?.sync_cwd).toBe(true)
    expect(structurePane(t)).toBeNull()
    expect(create_terminal_leaf().id).not.toBe(t.id)
  })
  it('structure leaf: structurePane returns the pane, terminalState null', () => {
    const s = create_empty_leaf()
    expect(isStructureLeaf(s)).toBe(true)
    expect(structurePane(s)).toBe(s.content.type === 'structure' ? s.content.pane : null)
    expect(terminalState(s)).toBeNull()
  })
  it('a terminal leaf is never "empty" and never an import target', () => {
    const t = create_terminal_leaf()
    expect(isEmptyLeaf(t)).toBe(false)
    const root = split('S', 'h', 0.5, t, create_empty_leaf())
    expect(findFirstEmptyLeaf(root)?.id).not.toBe(t.id) // the empty structure leaf, not the terminal
  })
})
```

- [ ] **Step 1.2: Run, verify fail** — `pnpm exec vitest run tests/desktop/pane-tree.test.ts` → FAIL (undefined exports).

- [ ] **Step 1.3: Widen the union + helpers** in `desktop/pane-tree.ts`. Replace `LeafContent`:

```ts
export interface TerminalLeafState {
  session_id?: string
  host?: string
  username?: string
  shell?: string
  sync_cwd: boolean
  cwd?: string
}

export type LeafContent =
  | { type: 'structure'; pane: PaneState }
  | { type: 'terminal'; term: TerminalLeafState }
```

Add helpers (place near `create_empty_leaf`):

```ts
export function isStructureLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'structure'
}

export function isTerminalLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'terminal'
}

export function structurePane(leaf: LeafNode): PaneState | null {
  return leaf.content.type === 'structure' ? leaf.content.pane : null
}

export function terminalState(leaf: LeafNode): TerminalLeafState | null {
  return leaf.content.type === 'terminal' ? leaf.content.term : null
}

export function create_terminal_leaf(opts?: Partial<TerminalLeafState>): LeafNode {
  return { kind: 'leaf', id: next_id('term'), content: { type: 'terminal', term: { sync_cwd: false, ...opts } } }
}
```

Update `isEmptyLeaf` so a terminal leaf is never empty (it already checks `content.type === 'structure'`, so a terminal leaf returns false — verify this is the case; if `isEmptyLeaf` was simplified during subproject 1, restore the `content.type === 'structure' &&` guard):

```ts
export function isEmptyLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'structure' && !pane_has_content(leaf.content.pane)
}
```

- [ ] **Step 1.4: Run, verify pass** — `pnpm exec vitest run tests/desktop/pane-tree.test.ts` → PASS (all blocks incl. the 3 new). Do NOT run `pnpm check` (consumers now red).

- [ ] **Step 1.5: Commit**

```bash
git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(terminal-leaves): widen LeafContent union + terminal helpers (WIP: guards next)"
```

---

## Task 2: Apply `structurePane()` guards across consumers (compiler-driven)

**Files:** Modify `desktop/lib/tab-manager.svelte.ts`, `desktop/lib/pane-manager.ts`, `desktop/lib/layout-manager.ts`, `desktop/lib/popout-manager.ts`, `desktop/lib/close-all-helper.ts`, `desktop/App.svelte`.

The TS union now errors at every `leaf.content.pane` (it's only valid after narrowing). Use `pnpm check` as the worklist.

- [ ] **Step 2.1: Enumerate** — Run `pnpm check 2>&1 | grep -E "content|pane|terminal" | head -80`. Each error at a `.content.pane` access is a guard site. Also `grep -rn "content\.pane" desktop --include=*.ts --include=*.svelte`.

- [ ] **Step 2.2: Apply the uniform guard.** Import `structurePane` (and `isTerminalLeaf`/`terminalState` where needed) from `'../pane-tree'` / `'./pane-tree'`. For each site:
  - Loop/iteration over leaves doing structure work → `const pane = structurePane(leaf); if (!pane) continue`.
  - Single-leaf resolution → `const pane = structurePane(findLeafById(ts.root, id)!); if (!pane) return/null`.
  - Two-way `bind:` in a structure branch already gated by `leaf.content.type === 'structure'` in the snippet (see Task 3) → no change needed there.

- [ ] **Step 2.3: Per-file specifics:**
  - **tab-manager**: badge = `leaves(ts.root).filter(l => isTerminalLeaf(l) || (structurePane(l) && pane_has_content(structurePane(l)!))).length` (terminals count as populated). `update_tab_label`: formula scan uses `structurePane`; if all leaves are terminals, label `Terminal`; `.some(l => structurePane(l)?.mode === 'workflow')` for workflow.
  - **pane-manager `handle_unload`/`close_panel`**: if `isTerminalLeaf(leaf)` → close directly (`removeLeaf` + the terminal close hook from Task 4), NO save banner. Structure path unchanged via `structurePane`.
  - **layout-manager**: `filled = leaves(ts.root).filter(l => isTerminalLeaf(l) || (structurePane(l) && pane_has_content(structurePane(l)!)))`; map surviving filled contents onto preset leaves (carry the whole `content`, not just the pane, so terminals survive a preset switch).
  - **popout-manager**: `popout_pane` — `const pane = structurePane(leaf)`; if null and `isTerminalLeaf(leaf)` → terminal popout branch (Task 4); else structure popout.
  - **close-all-helper**: iterate `structurePane(leaf)`; skip terminal leaves (they have no saveable structure).
  - **App.svelte** structure-only sites (SSE injectors, dirty-detect effect, `get_current_structure`, `apply_entry_to_pane`, `open_plugin_hub`, sample/builder cards, `on_save_workflow`): guard with `structurePane(...)`; terminal leaves skipped/ignored.

- [ ] **Step 2.4: Verify** — `pnpm check 2>&1 | grep -c error` trending to 0 for these files (render in Tasks 3/6/7 may still error until done). `pnpm exec vitest run tests/desktop/pane-tree.test.ts` green.

- [ ] **Step 2.5: Commit**

```bash
git add desktop/lib desktop/App.svelte
git commit -m "refactor(terminal-leaves): structurePane guards on structure-only consumers (WIP)"
```

---

## Task 3: Render terminal leaves (`PaneTree.svelte` + App `terminal_body` snippet)

**Files:** Modify `desktop/PaneTree.svelte`, `desktop/App.svelte`.

- [ ] **Step 3.1:** Add a `terminal_body: Snippet<[LeafNode]>` prop to `PaneTree.svelte` (alongside `leaf_body`). In the leaf branch, dispatch:

```svelte
<div class="panel-content">
  {#if leaf.content.type === 'terminal'}
    {@render terminal_body(leaf)}
  {:else}
    {@render leaf_body(leaf)}
  {/if}
</div>
```

- [ ] **Step 3.2:** In `App.svelte`, define `terminal_body` snippet rendering `TerminalPanel`:

```svelte
{#snippet terminal_body(leaf: LeafNode)}
  {@const term = leaf.content.type === 'terminal' ? leaf.content.term : undefined}
  {#if term}
    <TerminalPanel
      show_header={false}
      session_id={term.session_id}
      host={term.host}
      username={term.username}
      shell={term.shell}
      font_size={terminal_font_state.size}
      font_family={terminal_font_state.family}
      bind:sync_cwd={term.sync_cwd}
      on_cwd_change={(c) => { term.cwd = c }}
      on_open_file={(p) => open_path_in_editor_or_structure(p)}
      ondisconnect={() => close_terminal_leaf(tab.id, leaf.id)}
    />
  {/if}
{/snippet}
```

Import `TerminalPanel` into App (`import TerminalPanel from '$lib/structure/TerminalPanel.svelte'` or via the structure index) and `terminal_font_state` from `$lib/state.svelte`. Wire `terminal_body` into the `<PaneTree ... {terminal_body} />` call. `open_path_in_editor_or_structure` reuses the existing ctrl-click file-open handler (the same callback the old side-panel terminal used).

- [ ] **Step 3.3:** Update the leaf `header` snippet (App) for terminal leaves: label via a `terminalLabel(term)` helper (`term.host ?? term.shell ?? (term.cwd ? basename(term.cwd) : 'Terminal')`); popout button → `popout_terminal_leaf(tab.id, leaf.id)` (Task 4); close → `close_terminal_leaf(tab.id, leaf.id)`. Gate the structure-only bits (formula dot via `pane_has_content`) behind `structurePane(leaf)`.

- [ ] **Step 3.4: Commit**

```bash
git add desktop/PaneTree.svelte desktop/App.svelte
git commit -m "feat(terminal-leaves): render terminal leaf via TerminalPanel snippet + header"
```

---

## Task 4: Session lifecycle (`close_terminal_leaf`, `popout_terminal_leaf`, keep-warm)

**Files:** Modify `desktop/App.svelte`, `desktop/lib/popout-manager.ts`.

- [ ] **Step 4.1:** In App, add:

```ts
function close_terminal_leaf(tab_id: string, leaf_id: string) {
  const ts = tab_states[tab_id]
  if (!ts) return
  // TerminalPanel's ondisconnect already killed the PTY; just drop the leaf.
  if (leafCount(ts.root) <= 1) { ts.root = create_empty_leaf(); ts.active_leaf_id = ts.root.id }
  else { ts.root = removeLeaf(ts.root, leaf_id); if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id }
  update_tab_label(tab_id)
}
```

(The PTY is killed by `TerminalPanel.ondisconnect`; closing the leaf when the user clicks the leaf header close calls the panel's disconnect first — wire the header close to invoke disconnect then `close_terminal_leaf`. Simplest: header close = `close_terminal_leaf`, and `TerminalPanel`'s `onunmount`/`$effect` cleanup kills the PTY when the leaf unmounts.)

- [ ] **Step 4.2:** `popout_terminal_leaf(tab_id, leaf_id)` in App → reuse `popout-manager`'s existing terminal popout (`#terminal?session_id=…&host=…&username=…`) using `terminalState(leaf)`, then `removeLeaf` from the tree (mirrors current terminal popout behavior). Add a `popout_terminal` export to `popout-manager.ts` if not present (factor from the existing terminal popout path).

- [ ] **Step 4.3: Keep-warm** — confirm a terminal leaf in an inactive tab stays mounted (the tab `view-layer-hidden` uses `visibility:hidden`, not `display:none`, per subproject-1 — verify the same holds so xterm/PTY survive). No code change expected; add a smoke note.

- [ ] **Step 4.4: Commit**

```bash
git add desktop/App.svelte desktop/lib/popout-manager.ts
git commit -m "feat(terminal-leaves): session lifecycle (close kills PTY, popout, keep-warm)"
```

---

## Task 4b: Window-local terminal CWD sync + independent popout file system (T7)

**Files:** Modify `src/lib/structure/TerminalPanel.svelte`, `desktop/sidebar/cwd-sync.svelte.ts`, `desktop/lib/popout-manager.ts`, `desktop/App.svelte`.

**Two real bugs + one isolation requirement:**
1. **Local Directory Sync never worked.** `create_cwd_sync_cleanup` (`desktop/sidebar/cwd-sync.svelte.ts:20`) only sets up listeners when `source && source !== 'catgo' && source !== 'localdb'` — i.e. **only for HPC**. A LOCAL terminal + local Files panel (`source === 'catgo'`) gets NO listener, so `cd` never moves the local browser. It also only ever calls `set_hpc_current_path` — there is no local-nav path.
2. **Cross-window leak.** The producer broadcasts CWD via `BroadcastChannel` to ALL windows, moving the origin window's Files panel from a popout.
3. **Independent popout** (T7): a popped-out terminal should open a full app window with its own Files panel + sync.

- [ ] **Step 4b.1: Producer — drop cross-window broadcast.** In `src/lib/structure/TerminalPanel.svelte` (lines ~297-302), REMOVE the `try { const bc = new BroadcastChannel('catgo-terminal-cwd'); bc.postMessage({ path, session_id, seq }); bc.close() } catch {}` block. KEEP `on_cwd_change?.(path)` and the same-window `window.dispatchEvent(new CustomEvent('catgo-terminal-cwd', { detail: { path, session_id, seq } }))`. Net: CWD reaches only listeners in its OWN window.

- [ ] **Step 4b.2: Consumer — fix local sync + window-local.** Rewrite `create_cwd_sync_cleanup` in `desktop/sidebar/cwd-sync.svelte.ts` so it ALWAYS wires the same-window listener (for both local and HPC), routes by source, and drops the BroadcastChannel:

```ts
export function create_cwd_sync_cleanup(
  source: string,
  get_hpc_current_path: () => string,
  set_hpc_current_path: (path: string) => void,
  navigate_local: (path: string) => void,
): (() => void) {
  const apply = (path: string | undefined) => {
    if (!path) return
    const is_hpc = !!source && source !== `catgo` && source !== `localdb`
    if (is_hpc) {
      if (path !== get_hpc_current_path()) set_hpc_current_path(path)
    } else {
      navigate_local(path) // local Files panel follows the terminal CWD
    }
  }
  const win_handler = (event: Event) => apply((event as CustomEvent).detail?.path)
  window.addEventListener(`catgo-terminal-cwd`, win_handler)
  return () => window.removeEventListener(`catgo-terminal-cwd`, win_handler)
}
```

- [ ] **Step 4b.3: Caller — pass the local-nav callback.** In `desktop/Sidebar.svelte` (lines ~121-127), pass `fsb.fs_browse` as the 4th arg:

```svelte
$effect(() => {
  return create_cwd_sync_cleanup(
    source,
    () => hpc.hpc_current_path,
    (path) => { hpc.hpc_current_path = path },
    (path) => { fsb.fs_browse(path) },
  )
})
```

(Confirm `fsb` is in scope — it is, from `create_fs_browser_state` at Sidebar.svelte:255, and `fsb.fs_browse` is its exported nav. This is what makes `cd` in a local terminal move the local Files panel — the reported bug.)

- [ ] **Step 4b.3a: Verify** — `pnpm check` no new errors; manual: local terminal `cd /tmp` → Files panel navigates to `/tmp` (the fix); a popout's `cd` does NOT move the origin window.

- [ ] **Step 4b.4: Independent popout = full app window.** Change the terminal popout so it opens a NORMAL app window (with sidebar/file browser), not the bare `#terminal` `TerminalWindow`. In `popout-manager.ts`, add/adjust `popout_terminal_leaf(tab_id, leaf_id, ...)` to open `window.open(`${origin}${pathname}#newterm?session_id=…&host=…&username=…&sync_cwd=…`, ...)` where the popout window, on parsing `#newterm`, creates a **terminal-root tab** in its own app instance (full shell). Implement the `#newterm` hash handling in App's hash-route effect (App.svelte ~357-392): create a terminal tab seeded with `create_terminal_leaf({ session_id, host, username, sync_cwd })` and switch to it; do NOT enter the bare-popout `terminal` mode. The new window thus has its own sidebar + file browser + the terminal's own Directory Sync toggle, fully isolated.
  - The origin leaf is removed from the source window (`removeLeaf`) after opening, mirroring current popout behavior.
  - Tauri path: use `WebviewWindow` with the `#newterm` URL (same pattern as existing popouts).

- [ ] **Step 4b.5: Commit**

```bash
git add src/lib/structure/TerminalPanel.svelte desktop/sidebar/cwd-sync.svelte.ts desktop/lib/popout-manager.ts desktop/App.svelte
git commit -m "feat(terminal-leaves): window-local CWD sync + full-window terminal popout (independent file systems)"
```

> **Note for verification (Task 8):** smoke that a popped-out terminal's `cd` does NOT move the origin window's Files panel, and that the popout window has its own Files panel + Directory Sync toggle that follows only its own terminal.

---

## Task 5: Remove the desktop side-panel terminal (`Structure.svelte`, D8-gated)

**Files:** Modify `src/lib/structure/Structure.svelte`.

- [ ] **Step 5.1: D8 verify** — `grep -rn "initial_panel.*terminal\|show_terminal" src/lib/mobile` → empty (confirmed). Confirm no mobile-mounted path sets `initial_panel='terminal'` on a pane. If any exists, gate Step 5.2 behind `!isMobile()`.

- [ ] **Step 5.2:** Remove the desktop side-panel terminal: the `{#if show_terminal} <TerminalPanel .../>` block, the `show_terminal` state + its `terminal_layout`/`side_panel_size` terminal-specific wiring, and the `initial_panel === 'terminal' → show_terminal = true` trigger (Structure.svelte:1482-1484) and the toolbar terminal button (3730). KEEP the editor/preview/chat side-panel machinery (out of scope) — only strip the terminal arm of the side panel. The grid `side-split` classes stay for editor/preview.

- [ ] **Step 5.3: Verify D8** — `git diff --name-only feat/pane-tree-core...HEAD -- src/lib/mobile` empty. `pnpm check` no new mobile errors. MobileWorkspace `.mw-term` untouched.

- [ ] **Step 5.4: Commit**

```bash
git add src/lib/structure/Structure.svelte
git commit -m "refactor(terminal-leaves): remove desktop side-panel terminal (mobile .mw-term unaffected)"
```

---

## Task 6: Add-terminal entry points (landing card + "+Terminal" tab)

**Files:** Modify `desktop/App.svelte`, `desktop/lib/tab-manager.svelte.ts`, `desktop/TabBar.svelte`.

- [ ] **Step 6.1: Landing "Terminal" card** (App.svelte:2008-2013) — change its onclick from setting `pane.initial_panel='terminal'` to converting the leaf to a terminal:

```svelte
<button class="import-card terminal-card" onclick={() => {
  setLeafContent_terminal(ts.root, leaf.id)
  ts.active_leaf_id = leaf.id
  update_tab_label(tab.id)
}}>
```

Add a small App helper or a `pane-tree` op `setLeafContent(root, leafId, content): root` (pure, replaces a leaf's content) and call it with `{ type: 'terminal', term: { sync_cwd: false } }`. (Add `setLeafContent` to `pane-tree.ts` with a unit test — it generalizes `removeLeaf`'s replace; one test: replacing a structure leaf's content with terminal yields `isTerminalLeaf` true and same leaf id.)

- [ ] **Step 6.2: "+Terminal" tab** — `tab-manager.create_tab` accepts `'terminal'`; when type is terminal, seed `tab_states[id]` with a tab-state whose `root = create_terminal_leaf()` (add `create_terminal_tab_state()` to `pane-utils.ts` mirroring `create_tab_state` but with a terminal root). `TabBar.svelte`'s "+" menu offers "Terminal" (it already had a Terminal tab concept). Default label `Terminal`.

- [ ] **Step 6.3: Commit**

```bash
git add desktop/App.svelte desktop/lib/tab-manager.svelte.ts desktop/TabBar.svelte desktop/pane-tree.ts desktop/pane-utils.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(terminal-leaves): add-terminal via landing card + Terminal tab"
```

---

## Task 7: Top "Terminal" tab → pane tree (retire `TerminalWindow` body)

**Files:** Modify `desktop/App.svelte`.

- [ ] **Step 7.1:** Replace the `{:else if tab.type === 'terminal'} <TerminalWindow .../>` branch (App.svelte:2073-2074) so a terminal tab renders the same `<PaneTree node={ts.root} .../>` workspace as a structure tab (its root is a terminal leaf from Task 6.2). Effectively: the `tab.type === 'structure'` and `tab.type === 'terminal'` render branches converge to the same PaneTree block (gate on `tab.type === 'structure' || tab.type === 'terminal'`).

- [ ] **Step 7.2:** Remove the now-unused `TerminalWindow` import from App (line 24) if no other App use remains (keep `DopingPTWindow`). Leave `TerminalWindow.svelte` on disk (other importers: `WorkflowView.svelte`, `index.ts`).

- [ ] **Step 7.3: Commit**

```bash
git add desktop/App.svelte
git commit -m "feat(terminal-leaves): top Terminal tab renders via PaneTree (retire TerminalWindow body)"
```

---

## Task 8: Verification gate + review

**Files:** none (verify + residual fixes).

- [ ] **Step 8.1:** `pnpm check 2>&1 | tail -5` → **0 errors**. Fix stragglers (every `content.pane` must be narrowed).
- [ ] **Step 8.2:** `pnpm exec vitest run --reporter=dot 2>&1 | tail -5` → all pass (4039 baseline + new pane-tree tests; RdfPlot flake tolerated).
- [ ] **Step 8.3: D8** — `git diff --name-only feat/pane-tree-core...HEAD -- src/lib/mobile` → empty.
- [ ] **Step 8.4: Manual smoke** (`pnpm desktop:serve`): landing Terminal card → terminal fills leaf; split a structure pane, make the new cell a terminal (via landing card on the empty leaf); recursive split to 4 terminals; close a terminal (PTY dies, sibling fills); switch tab away and back (terminal + CWD survive); popout a terminal; "+Terminal" tab opens a terminal then splits to 4; structure tabs still behave (subproject-1 parity).
- [ ] **Step 8.5: Final review** + commit any fixes.

```bash
git add -A && git commit -m "feat(terminal-leaves): green — terminals are pane-tree leaves (subproject 2)"
```

---

## Self-review notes (author)
- Spec coverage: union (§4)→T1; guard rollout (§5)→T2; render (§6)→T3; lifecycle (§7)→T4; side-panel removal (§8)→T5; add-terminal UX (T5 spec §5)→T6; top tab (§9)→T7; testing (§10)→T1/T8.
- `structurePane()` centralizes the guard; the TS union is the completeness checklist (no silent miss).
- `setLeafContent` added in T6 (pure op, tested) — also useful for subproject 3.
- Keep-warm relies on subproject-1's `visibility:hidden` tab layering (verify in T4.3/T8.4).
- D8 gates at T5.1/T5.3/T8.3.
