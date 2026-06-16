# Open-File Destination (Subproject 5) Implementation Plan

> **For agentic workers:** Additive; keep the build green.

**Goal:** When opening a structure from the filesystem, let the user choose **split pane** (current) or **new draggable window** (multi-monitor). A global default setting + a per-open **Shift** override. Delivers the user's original request #2.

**Architecture:** A persisted `open_target: 'split' | 'window'` `$state` (localStorage, mirroring `pane_font_size_state`). A `resolve_open_target(shiftKey)` helper flips the default when Shift is held. The two user-initiated single-file entry points — `handle_open_file` (picker) and `handle_drop` (drag) — branch: if resolved target is `window` and it's a **single** file, call `parse_and_open_structure_window` (already exists); else split as today. Batch (folder / multi-file) always splits (popout is one-window-per-structure). A toggle lives in the Sidebar. **D8: no `Structure.svelte`/mobile edit.**

**Tech Stack:** Svelte 5 runes, TS, Vitest. No formatter — write single-quote/no-semicolon/2-space by hand.

---

## Task 1: Persisted `open_target` setting + resolver (TDD)

**Files:** Modify `src/lib/state.svelte.ts`; Test `tests/desktop/open-target.test.ts` (new).

- [ ] **Step 1.1: Failing test** — create `tests/desktop/open-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolve_open_target } from '../../src/lib/state.svelte'

describe('resolve_open_target', () => {
  it('returns the default when shift is not held', () => {
    expect(resolve_open_target('split', false)).toBe('split')
    expect(resolve_open_target('window', false)).toBe('window')
  })
  it('flips the default when shift is held', () => {
    expect(resolve_open_target('split', true)).toBe('window')
    expect(resolve_open_target('window', true)).toBe('split')
  })
})
```

Add `tests/desktop/**` is already in `vitest.config.ts` include (from subproject 1).

- [ ] **Step 1.2: Run, fail.** `pnpm exec vitest run tests/desktop/open-target.test.ts`.
- [ ] **Step 1.3: Implement** in `src/lib/state.svelte.ts` (mirror the `pane_font_size_state` localStorage pattern):

```ts
const OPEN_TARGET_KEY = `catgo-open-target`
let initial_open_target: 'split' | 'window' = 'split'
if (typeof window !== `undefined` && globalThis.localStorage) {
  const saved = localStorage.getItem(OPEN_TARGET_KEY)
  if (saved === 'split' || saved === 'window') initial_open_target = saved
}
export const open_target_state = $state<{ value: 'split' | 'window' }>({ value: initial_open_target })
export function set_open_target(v: 'split' | 'window'): void {
  open_target_state.value = v
  if (typeof window !== `undefined` && globalThis.localStorage) localStorage.setItem(OPEN_TARGET_KEY, v)
}
/** Per-open override: holding Shift flips the global default. */
export function resolve_open_target(deflt: 'split' | 'window', shift: boolean): 'split' | 'window' {
  if (!shift) return deflt
  return deflt === 'split' ? 'window' : 'split'
}
```

- [ ] **Step 1.4: Run, pass. Commit** `git add src/lib/state.svelte.ts tests/desktop/open-target.test.ts && git commit -m "feat(open-target): persisted setting + resolve_open_target"`.

## Task 2: Branch the two single-file entry points

**Files:** Modify `desktop/App.svelte`, `desktop/lib/drag-drop-handlers.ts`.

- [ ] **Step 2.1:** Import `open_target_state`, `resolve_open_target` and `parse_and_open_structure_window` into App (the popout helper is in `desktop/lib/popout-manager.ts` — check whether App already imports from it; add `parse_and_open_structure_window` to that import).
- [ ] **Step 2.2: `handle_open_file`** (App.svelte:773) — it takes no event today, so thread the Shift state. The "Open File" buttons that call `handle_open_file(tab.id, leaf.id)` are click handlers with an event — change those call sites to `handle_open_file(tab.id, leaf.id, e.shiftKey)` and widen the signature to `(tab_id, leaf_id, shift = false)`. After reading the picked files (`results`), before `import_many`, branch:

```ts
const target = resolve_open_target(open_target_state.value, shift)
if (target === 'window' && results.length === 1) {
  await parse_and_open_structure_window(results[0].content, results[0].filename, is_tauri)
  return
}
// else: existing import_many(...) split path
```

(Apply the same single-file branch in the web `handle_file_input` path if it shares the results handling — if it's cleanly separable, branch there too; otherwise leave the input-change path as split-only and note it. The picker button is the primary path.)

- [ ] **Step 2.3: `handle_drop`** (`desktop/lib/drag-drop-handlers.ts`) — it already has the `DragEvent` (`event.shiftKey`). In the single-file branch (where `to_import.length === 1` or the single-file content path), before `import_many`/`process_file_content`, resolve the target and divert to popout if `window`. Add `open_target_state`/`resolve_open_target`/`parse_and_open_structure_window` imports to the handler (or pass a `resolve` callback via `DragDropDeps` to keep the handler pure — preferred: add `deps.open_in_window(content, filename)` callback wired in App to `parse_and_open_structure_window`, and `deps.get_open_target()` returning `open_target_state.value`). Batch drops (multi-file/folder) always split.

- [ ] **Step 2.4: Commit** `git add desktop/App.svelte desktop/lib/drag-drop-handlers.ts && git commit -m "feat(open-target): single-file open/drop respects setting + Shift override"`.

## Task 3: Sidebar toggle UI

**Files:** Modify `desktop/Sidebar.svelte` (D8-safe — desktop only).

- [ ] **Step 3.1:** Add a small toggle near the file-browser controls: "Open files in: ( ) Split ( ) New window", bound to `open_target_state.value` via `set_open_target`. Keep it minimal — two segmented buttons or a select. Import `open_target_state` / `set_open_target` from `$lib/state.svelte`.
- [ ] **Step 3.2:** i18n: add `open_in_split` / `open_in_window` / `open_files_in` to BOTH `src/lib/i18n/en/app.ts` and `src/lib/i18n/zh/app.ts` (parity). en: "Split pane" / "New window" / "Open files in". zh: "分屏" / "新窗口" / "打开文件到".
- [ ] **Step 3.3: Commit** `git add desktop/Sidebar.svelte src/lib/i18n && git commit -m "feat(open-target): sidebar toggle + i18n"`.

## Task 4: Verify

- [ ] **Step 4.1:** `pnpm check 2>&1 | tail -3` → **0 errors**.
- [ ] **Step 4.2:** `pnpm exec vitest run 2>&1 | tail -5` → no NEW failures (open-target test + i18n parity pass; RdfPlot flake tolerated).
- [ ] **Step 4.3: D8** — `git diff --name-only feat/pane-tree-core...HEAD -- src/lib/mobile src/lib/structure/Structure.svelte` → empty.
- [ ] **Step 4.4: Manual smoke** (`pnpm desktop:serve`): set toggle to "Split", open a file → lands in a split pane (current behavior); set "New window", open a file → opens a draggable popout window; Shift+click "Open File" with default Split → opens a window (override); Shift+drop a single file → opposite of default; folder/multi-file import always splits regardless; setting persists across reload (localStorage).

## Notes
- Batch always splits (popout is one structure per window) — only single-file opens/drops branch.
- `parse_and_open_structure_window` already handles Tauri vs `window.open` and the localStorage transfer — reuse as-is.
- D8: setting UI in Sidebar (desktop), not Structure.svelte. The setting `$state` lives in shared `state.svelte.ts` but is desktop-consumed; mobile import flow is separate (MobileWorkspace) and unaffected — verify the diff.
- Capture `resolve_open_target(...)` once at the start of each entry point (before any async) so a mid-import toggle can't change in-flight behavior.
