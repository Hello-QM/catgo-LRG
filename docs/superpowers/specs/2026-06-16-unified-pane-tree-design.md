# Unified Pane Tree — Design

**Date:** 2026-06-16
**Status:** Draft for review
**Scope:** Desktop workspace layout. **Mobile is explicitly out of scope and must not change.**

---

## 1. Motivation

Today the desktop workspace has two unrelated layout systems:

1. **Structure panes** (`desktop/pane-utils.ts`): a fixed grid with four layout modes —
   `single | splitH | splitV | quad` — capped at 4 panes, each holding one
   structure / trajectory / cube / workflow. A single `col_split` + `row_split`
   pair drives all dividers.
2. **Terminal** (`src/lib/structure/TerminalPanel.svelte` as an in-viewer side panel,
   plus a top-level "Terminal" tab and a separate `TerminalWindow.svelte` that has
   multi-tab + a single binary split that is *not wired into the viewer*).

Users want:

- **R1.** A terminal that can cover the whole page instead of half-structure /
  half-terminal.
- **R2.** When opening a structure from the filesystem, a choice between taking a
  split pane (current) or popping out a **draggable, multi-monitor** window.
- **R3.** Terminal splitting — up to 4 terminals per tab, with multiple tabs.
- **R4.** **User-defined** split layouts (e.g. "left column = 2 stacked, right = 1",
  or "2×2"), not just the symmetric presets.
- **R5.** A split cell may hold a **structure** (3D viewer), not only a terminal.

The fixed `quad` grid cannot express R4 (it is always a symmetric 2×2; you cannot
merge two cells into one). R5 means cells must be content-agnostic. Together these
point to a single recursive layout primitive that both structures and terminals
share.

## 2. Decisions (locked with the user)

| # | Decision |
|---|----------|
| D1 | One **recursive binary pane tree** is the single layout primitive; leaf content is `structure` **or** `terminal`. It **replaces** the `quad` grid. |
| D2 | Execution is a **phased strangler**, not a big-bang rewrite. Ship a behavior-equivalent migration first, then add capability. |
| D3 | "Maximize terminal" covers the **3D viewer only** (tab bar + sidebar stay; canvas kept warm). Generalizes later to "zoom any leaf". |
| D4 | Open-file destination = a **global default setting + per-open override** (split pane vs new window). |
| D5 | Multi-tab + split work in **both** the in-viewer terminal surface and the top-level Terminal tab, via a **shared component**. |
| D6 | Leaf cap per tab = **4** (tunable). Covers the stated layouts (left-2-right-1 = 3, 2×2 = 4). |
| D7 | Migrated `quad` dividers become **independent** (more powerful) rather than the old linked center cross. Reversible to linked if desired. |
| **D8** | **Mobile must not change.** No behavioral or markup change to `src/lib/mobile/*`, `MobileWorkspace`, `MobileTerminal`, or any `TAURI_DEV_HOST`/mobile-gated branch. |

## 3. Hard constraints

- **Mobile untouched (D8).** The entire desktop pane system lives under `desktop/`
  and mobile imports none of it (verified: `grep -rl pane-utils src/lib/mobile` is
  empty). Subproject 1 is therefore mobile-safe by construction. `Structure.svelte`
  is shared (mounted by `MobileWorkspace`); any edit to it must be desktop-gated and
  verified not to alter mobile rendering. The design *reduces* shared surface by
  lifting terminal-side-panel logic out of `Structure.svelte` into the desktop tree.
- **iOS invariants preserved** (per `CLAUDE.md` / `deploy/ios/LOCAL-TESTING-PROGRESS.md`):
  do not silently revert `Icon.svelte height:1em`, the keep-warm off-screen viewer
  rule, etc.
- **GPU envelope.** Each `structure` leaf is a live WebGL canvas. Cap (D6 = 4) keeps
  us within today's `quad`-era envelope. Hidden/zoomed leaves stay warm off-screen
  (never `display:none` a viewer canvas).
- **No persistence change required.** Tab/pane state is in-memory; the model can be
  rewritten without a migration format.

## 4. Core model

Per-tab layout is a binary tree:

```ts
type PaneNode = SplitNode | LeafNode

interface SplitNode {
  kind: 'split'
  id: string
  direction: 'h' | 'v'          // 'h' = side by side (vertical divider); 'v' = stacked (horizontal divider)
  ratio: number                 // fraction (0..1) given to children[0]
  children: [PaneNode, PaneNode] // strictly binary
}

interface LeafNode {
  kind: 'leaf'
  id: string
  content: LeafContent
}

type LeafContent =
  | { type: 'structure'; pane: PaneState } // wraps the EXISTING PaneState verbatim
  | { type: 'terminal'; session: TerminalLeafState } // added in subproject 2
  | { type: 'empty' }
```

Key point: a `structure` leaf **wraps the existing `PaneState`** unchanged, so it
keeps every current content variant (`structure` / `trajectory` / `cube_file` /
`workflow`) and all downstream logic (formula label, MCP `is_active`, popout
serialization). Migration is lossless.

### 4.1 Layouts as tree shapes

| Layout | Tree |
|--------|------|
| single | `leaf` |
| splitH (left\|right) | `split(h, [leaf, leaf])` |
| splitV (top/bottom) | `split(v, [leaf, leaf])` |
| quad | `split(h, [ split(v,[leaf,leaf]), split(v,[leaf,leaf]) ])` |
| **left-2-right-1** | `split(h, [ split(v,[leaf,leaf]), leaf ])` |
| **top-1-bottom-2** | `split(v, [ leaf, split(h,[leaf,leaf]) ])` |

The four legacy presets are special cases, giving the migration exact anchors.

### 4.2 Tree operations (pure functions, unit-testable)

- `findFirstEmptyLeaf(root): id | null`
- `splitLeaf(root, leafId, direction, newContent): root` — replaces the leaf with a
  `split` of `[oldLeaf, newLeaf]`; refuses if `leafCount(root) >= CAP`.
- `removeLeaf(root, leafId): root` — drops the leaf and **collapses** its parent
  split so the sibling takes the parent's place (and ratio slot).
- `setRatio(root, splitId, ratio): root`
- `leafCount(root)`, `leaves(root)`, `setLeafContent(root, leafId, content)`.
- `matchesPreset(root): 'single'|'splitH'|'splitV'|'quad'|'custom'` — drives the
  layout-toggle UI's active state.

All operations are immutable (return a new tree) for clean Svelte 5 `$state`
reactivity and trivial testing.

## 5. Rendering

A recursive Svelte component `PaneTree.svelte`:

- A `SplitNode` renders a flex container (`row` for `h`, `column` for `v`) with
  child A, a 6px **divider**, child B; child A gets `flex-basis: ratio%`. Each split
  owns its own divider + ratio (enables independent quad dividers, D7).
- A `LeafNode` renders the leaf chrome (header: label, type switcher [subproj 3],
  popout, maximize [subproj 4], close) plus its content.
- Resize: pointer drag on a divider updates that split's `ratio` (clamped 0.15–0.85),
  double-click resets to 0.5. Replaces the global `col_split`/`row_split` handlers.
- **Canvas/xterm fit:** a `ResizeObserver` per leaf drives the viewer canvas resize
  and xterm `FitAddon`, replacing the global `window.dispatchEvent('resize')` hack.
  More robust and scoped (only the resized leaf reflows).

## 6. Subproject 1 — Pane-tree core (behavior-equivalent migration)

**Goal:** replace the `quad` grid with the tree, with **no user-visible behavior
change** except the independent-quad-divider improvement (D7). Desktop-only.

### 6.1 State change

`desktop/pane-utils.ts` `StructureTabState`:

- Remove: `panes: PaneState[4]`, `layout: LayoutType`, `active_pane: number`,
  `col_split`, `row_split`.
- Add: `root: PaneNode`, `active_leaf_id: string`.
- Keep: `library`, `active_library_id`, `close_confirm_*` (keyed by leaf id now).

### 6.2 Behaviors to preserve (parity checklist)

| Current behavior | Tree implementation |
|------------------|--------------------|
| Open file → fill source pane, else first empty, else auto-upgrade `single→splitH→quad`, else new tab | `findFirstEmptyLeaf`; if none and `leafCount < CAP` → `splitLeaf(active, defaultDir)`; if `== CAP` → new tab. **Escalation differs (see §6.5):** the tree adds one leaf at a time (1→2→3→4, no empty cell) instead of legacy's jump to a 4-cell `quad` with an empty slot. |
| Pane popout | popout the leaf's `PaneState` (unchanged serialization in `popout-manager.ts`). |
| Inactive-tab badge = # populated panes | `leaves(root).filter(non-empty).length`. |
| Close pane (confirm/save) → reduce layout | `removeLeaf` + parent collapse; reuse `pane-manager.ts` confirm flow keyed by leaf id. |
| Divider drag / double-click reset | per-split `setRatio` in `resize-handlers.ts`. |
| MCP `is_active` gating | active leaf id; only the active `structure` leaf syncs. |
| Layout toggle buttons (single/splitH/splitV/quad) | build the corresponding preset tree; highlight via `matchesPreset`. |
| Keyboard shortcuts (pane nav) | operate over `leaves(root)` order. |

### 6.3 Touched files (desktop only)

`pane-utils.ts` (model + ops), `App.svelte` (render `PaneTree` instead of the grid),
`resize-handlers.ts`, `pane-manager.ts`, `tab-manager.svelte.ts`,
`popout-manager.ts`, `keyboard-shortcuts.ts`, `layout-manager.ts`,
`drag-drop-handlers.ts`, `close-all-helper.ts`, `export-handlers.ts`,
`sidebar-handlers.ts`, `StructureLibrary.svelte`. New: `PaneTree.svelte`,
`pane-tree.ts` (pure ops) + its test.

### 6.4 Testing

- Unit: pure tree ops (`splitLeaf`, `removeLeaf` + collapse, `setRatio`,
  `findFirstEmptyLeaf`, `matchesPreset`, preset builders) — exhaustive, including
  the cap boundary and collapse-to-sibling.
- Parity: a table-driven test asserting the open-file escalation
  (single→splitH→quad→new-tab) matches the legacy sequence.
- `pnpm test` green; `pnpm check` clean.
- **Mobile smoke:** confirm `MobileWorkspace` renders unchanged and no
  `src/lib/mobile/*` file is touched (diff check).

### 6.5 The two intended visible deltas

Subproject 1 is "behavior-equivalent" with exactly two deliberate exceptions —
called out so review does not flag them as regressions:

1. **Independent quad dividers (D7).** The old linked center cross becomes two
   independent dividers. Reversible to linked if undesired.
2. **One-leaf-at-a-time escalation.** Opening a 3rd file from a 2-pane split adds a
   3rd leaf (e.g. left-1 / right-2) rather than jumping to a 4-cell `quad` with one
   empty slot. This removes the forced empty cell and is the natural behavior of the
   free-split model the user asked for. *Alternative if strict parity is preferred:*
   `splitLeaf` can target a full `quad` preset on the escalation step, keeping the
   empty-cell behavior. **Recommendation: adopt one-at-a-time.**

## 7. Subprojects 2–5 (sketch; each gets its own spec + plan)

2. **Terminal leaf.** Add `LeafContent.terminal`; reuse `TerminalPanel.svelte` inside
   a leaf. Lift the in-viewer terminal side panel out of the shared
   `Structure.svelte` into a desktop tree leaf (shrinks shared surface, D8-positive).
   Reconcile the top-level "Terminal" tab and `TerminalWindow.svelte` to use the same
   `PaneTree`. Multi-tab terminals fall out of the existing app tab system.
3. **Heterogeneous + type switch.** Leaf header dropdown to switch `terminal ⇄
   structure`; "split and pick type". Delivers R5.
4. **Leaf maximize / zoom.** Per-leaf maximize button; zoom one leaf to fill the tab,
   others kept warm off-screen. Delivers R1 (and generalizes it).
5. **Open-file destination.** Setting `open_target: 'split' | 'window'` + per-open
   override (menu / modifier key). Reuses existing `popout_pane`. Delivers R2; mostly
   independent — the `window` path can ship early since popout already exists.

## 8. Risks & mitigations

- **Wide blast radius in subproject 1** — ~14 desktop files reference `pane-utils`.
  *Mitigation:* keep `PaneState` and the popout serialization unchanged; only the
  container model changes. Pure tree ops are unit-tested before wiring. Behavior
  parity table guards the escalation logic.
- **Multiple WebGL canvases** — capped at 4 (D6), same as today's quad.
- **Shared `Structure.svelte`** — subproject 1 does not touch it; later subprojects
  gate edits behind desktop and verify mobile via diff + smoke.
- **Two intended visible changes** in subproject 1 (D7 independent dividers +
  one-at-a-time escalation) are enumerated in §6.5 so review doesn't flag them as
  regressions.

## 9. Out of scope

- Mobile (any change). Persisted layouts across sessions. Drag-to-reorder leaves
  (could be a later enhancement). More than 4 leaves per tab.
