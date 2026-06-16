# Leaf Type Switcher (Subproject 3) Implementation Plan

> **For agentic workers:** Additive; keep the build green.

**Goal:** Let the user change a leaf's content type in place — switch any cell between **Structure**, **Terminal**, and **Empty** — via a small dropdown in the leaf header. Completes the heterogeneous-leaves story (e.g. turn a terminal cell into a structure, or vice-versa).

**Architecture:** A header "type" button opens a small inline dropdown (Structure / Terminal / Empty). Selecting calls `setLeafContent(ts.root, leaf.id, <content>)`. Switching away from a terminal unmounts its `TerminalPanel` → its `$effect` cleanup kills the PTY (verified in subproject 2). Pure scalar menu state in App; no tree-op or model changes. **D8: no `Structure.svelte`/mobile edit** — all in `desktop/` + i18n. **YAGNI:** no split-and-choose-type context menu in v1 (split still makes an empty structure leaf, which the user can then switch).

**Tech Stack:** Svelte 5 runes, TS, Vitest. No formatter — write single-quote/no-semicolon/2-space by hand.

---

## Task 1: Type-switch handler + content factories

**Files:** Modify `desktop/App.svelte`.

- [ ] **Step 1.1:** Add a `switch_leaf_type(tab_id, leaf_id, type)` function:

```ts
function switch_leaf_type(tab_id: string, leaf_id: string, type: 'structure' | 'terminal' | 'empty') {
  const ts = tab_states[tab_id]
  if (!ts) return
  const content = type === 'terminal'
    ? { type: 'terminal' as const, term: { sync_cwd: false } }
    : { type: 'structure' as const, pane: create_empty_pane() } // 'structure' and 'empty' are both an empty structure leaf
  ts.root = setLeafContent(ts.root, leaf_id, content)
  ts.active_leaf_id = leaf_id
  if (ts.maximized_leaf_id && !findLeafById(ts.root, ts.maximized_leaf_id)) ts.maximized_leaf_id = null
  type_menu_leaf_id = null
  update_tab_label(tab_id)
}
```

(`setLeafContent`, `create_empty_pane`, `findLeafById` are already imported. 'structure' and 'empty' both yield a fresh empty structure leaf — the difference is only the label the menu shows; an empty structure leaf renders the landing page, a 'structure' choice is identical. Keep both menu entries for clarity, both call with an empty structure pane.)

- [ ] **Step 1.2:** Add menu state: `let type_menu_leaf_id = $state<string | null>(null)`.
- [ ] **Step 1.3: Commit** `git add desktop/App.svelte && git commit -m "feat(type-switch): switch_leaf_type handler"`.

## Task 2: Header type button + dropdown

**Files:** Modify `desktop/App.svelte`.

- [ ] **Step 2.1:** In the `header` snippet (BOTH structure and terminal arms), add a "type" button (before the maximize button), shown when `multi`:

```svelte
<button class="panel-type-btn" onclick={(e) => { e.stopPropagation(); type_menu_leaf_id = type_menu_leaf_id === leaf.id ? null : leaf.id }}
  title={t(`app.change_pane_type`)}>
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
</button>
{#if type_menu_leaf_id === leaf.id}
  <div class="panel-type-menu" role="menu">
    <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'structure') }}>{t(`app.type_structure`)}</button>
    <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'terminal') }}>{t(`app.type_terminal`)}</button>
    <button role="menuitem" onclick={(e) => { e.stopPropagation(); switch_leaf_type(tab.id, leaf.id, 'empty') }}>{t(`app.type_empty`)}</button>
  </div>
{/if}
```

- [ ] **Step 2.2:** Add a global click-away `$effect` to close the menu:

```ts
$effect(() => {
  if (type_menu_leaf_id === null) return
  const close = () => { type_menu_leaf_id = null }
  window.addEventListener('click', close)
  return () => window.removeEventListener('click', close)
})
```

(The buttons `e.stopPropagation()` so a click on them doesn't immediately close before handling.)

- [ ] **Step 2.3:** CSS: `.panel-type-btn` mirrors `.panel-popout-btn` (hover-reveal). `.panel-type-menu` is a small absolutely-positioned dropdown (position relative to the header; `position:absolute; top:24px; right:8px; z-index:1000; background:var(--page-bg); border:1px solid var(--border-color); border-radius:4px;` with vertically-stacked menuitem buttons). Keep it minimal.
- [ ] **Step 2.4:** i18n — add `change_pane_type`, `type_structure`, `type_terminal`, `type_empty` to BOTH `src/lib/i18n/en/app.ts` and `src/lib/i18n/zh/app.ts` (en/zh parity enforced by tests). en: "Change pane type" / "Structure" / "Terminal" / "Empty". zh: "切换面板类型" / "结构" / "终端" / "清空".
- [ ] **Step 2.5: Commit** `git add desktop/App.svelte src/lib/i18n && git commit -m "feat(type-switch): header type dropdown + i18n"`.

## Task 3: Verify

- [ ] **Step 3.1:** `pnpm check 2>&1 | tail -3` → **0 errors**.
- [ ] **Step 3.2:** `pnpm exec vitest run 2>&1 | tail -5` → no NEW failures (i18n parity passes; RdfPlot flake tolerated).
- [ ] **Step 3.3: D8** — `git diff --name-only feat/pane-tree-core...HEAD -- src/lib/mobile src/lib/structure/Structure.svelte` → empty.
- [ ] **Step 3.4: Manual smoke** (`pnpm desktop:serve`): split to ≥2 leaves; on a structure leaf, type-menu → Terminal → it becomes a terminal (PTY spawns); on a terminal leaf, type-menu → Structure → terminal's PTY is killed (no zombie) and the cell shows the structure landing; → Empty resets to landing; menu closes on outside click; maximize + type-switch interplay OK (stale-clamp clears a dangling maximize).

## Notes
- Switching away from a terminal relies on `TerminalPanel` unmount killing the PTY (subproject-2 verified) — `setLeafContent` replaces `content`, unmounting the `terminal_body` `TerminalPanel`.
- All scalar/tree-op-based; clone-on-assign + reactivity safe (`ts.root = setLeafContent(...)` reassigns).
- D8: header snippet renders in PaneTree (desktop). No `Structure.svelte`/mobile edit.
