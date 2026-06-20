# CatBot load-into-existing-viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When CatBot loads a NEW structure while a viewer already shows one, ask the user where it goes (overwrite / new pane / new window) instead of silently overwriting; in-place edits still apply directly.

**Architecture:** Tag structure pushes `intent:"load"|"edit"`. The viewer ignores `load` pushes when it already has a structure (no auto-overwrite). The CatBot card (PR #370) fires on `load` only, gains a 覆盖 option when a sibling viewer exists, and is wired on the docked chat too.

**Tech Stack:** FastAPI (Python backend, MCP), Svelte 5 runes (FE), EventSource SSE.

## Global Constraints
- Formatting: `deno fmt` (single quotes, no semicolons, 2-space, 90-col); `.svelte` excluded.
- i18n: keep `src/lib/i18n/{en,zh}/*.ts` key sets in parity.
- Svelte 5 runes only. Default `intent` is `"edit"` (back-compat: existing callers unchanged).
- CI gate = `vitest` (`pnpm test`). Backend tests via `pytest` in `server/`.
- Spec: `docs/superpowers/specs/2026-06-17-catbot-load-into-existing-viewer-design.md`.

---

### Task 1: Backend — carry `intent` through the push → SSE

**Files:**
- Modify: `server/catgo/routers/view_state.py` (`notify_structure`, ~line 89)
- Modify: `server/catgo/mcp_tools/helpers.py` (`_push_structure_to_viewer`, ~line 145)
- Test: `server/tests/test_push_intent.py` (create)

**Interfaces:**
- Produces: `notify_structure(panel_id: str, struct: dict, intent: str = "edit")` — SSE `structure` event data becomes `{"structure": ..., "intent": intent}`.
- Produces: `_push_structure_to_viewer(..., intent: str = "edit")` — forwards `intent` to the pending-update POST (`?intent=` query or body field) so `notify_structure` receives it.

- [ ] **Step 1: Failing test** — `server/tests/test_push_intent.py`:
```python
import sys
from pathlib import Path
_d = str(Path(__file__).resolve().parent.parent)
if _d not in sys.path: sys.path.insert(0, _d)
from catgo.routers import view_state

def test_notify_structure_default_intent_edit(monkeypatch):
    seen = {}
    monkeypatch.setattr(view_state, "_emit", lambda pid, ev, data: seen.update(ev=ev, data=data), raising=False)
    view_state.notify_structure("p1", {"sites": []})
    assert seen["data"]["intent"] == "edit"

def test_notify_structure_load_intent(monkeypatch):
    seen = {}
    monkeypatch.setattr(view_state, "_emit", lambda pid, ev, data: seen.update(data=data), raising=False)
    view_state.notify_structure("p1", {"sites": []}, intent="load")
    assert seen["data"]["intent"] == "load"
```
> NOTE: read `notify_structure`'s real body first; it likely calls an internal queue/emit. Adapt the monkeypatch target to the actual emit mechanism (the SSE writer). The assertion is: the event payload includes `intent`.

- [ ] **Step 2: Run — expect FAIL** (`intent` not in payload): `cd server && python -m pytest tests/test_push_intent.py -v`
- [ ] **Step 3: Implement** — add `intent: str = "edit"` param to `notify_structure`; include `"intent": intent` in the emitted `structure` event data. In `/structure/pending-update` (view_capture.py:381) read an `intent` query param (default "edit") and pass to `notify_structure`. In `_push_structure_to_viewer`, add `intent="edit"` param and forward it (query string `?intent={intent}`) on the pending-update POST.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(view): carry load/edit intent through structure push → SSE"`

---

### Task 2: Backend — load tools push `intent="load"`

**Files:**
- Modify: the MCP load tools that call `_push_structure_to_viewer` (grep `server/catgo/mcp_tools/` for fetch_crystal / fetch_molecule / load / reticular-build) — pass `intent="load"`.
- Edit tools (supercell/doping/slab/…) leave the default `"edit"`.

**Interfaces:** Consumes `_push_structure_to_viewer(..., intent=...)` from Task 1.

- [ ] **Step 1:** `grep -rn "_push_structure_to_viewer" server/catgo/mcp_tools/` — list every caller.
- [ ] **Step 2:** For each LOAD tool (fetches a brand-new structure / builds from nothing), pass `intent="load"`. Leave edit tools unchanged.
- [ ] **Step 3:** Manual check: `grep -rn "intent=\"load\"" server/catgo/mcp_tools/` shows only load tools.
- [ ] **Step 4: Commit** — `git commit -am "feat(mcp): load tools tag pushes intent=load"`

---

### Task 3: Viewer holds `load` pushes when non-empty

**Files:**
- Modify: `src/lib/structure/controllers/tool-handler.ts` (`start_sse_subscription`, the `on_struct_payload` handler ~line 206)
- Test: `tests/vitest/structure/load-intent-hold.test.ts` (create)

**Interfaces:**
- Produces: a pure predicate `should_apply_push(intent: string | undefined, viewer_has_structure: boolean): boolean` — returns `false` only when `intent === "load" && viewer_has_structure`.

- [ ] **Step 1: Failing test** — `tests/vitest/structure/load-intent-hold.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { should_apply_push } from '$lib/structure/controllers/tool-handler'

describe('should_apply_push', () => {
  it('applies edits always', () => {
    expect(should_apply_push('edit', true)).toBe(true)
    expect(should_apply_push(undefined, true)).toBe(true)
  })
  it('applies a load into an empty viewer', () => {
    expect(should_apply_push('load', false)).toBe(true)
  })
  it('holds a load when the viewer already has a structure', () => {
    expect(should_apply_push('load', true)).toBe(false)
  })
})
```
- [ ] **Step 2: Run — expect FAIL** (not exported): `pnpm exec vitest run tests/vitest/structure/load-intent-hold.test.ts`
- [ ] **Step 3: Implement** — export `should_apply_push` from tool-handler.ts:
```ts
export function should_apply_push(intent: string | undefined, viewer_has_structure: boolean): boolean {
  return !(intent === `load` && viewer_has_structure)
}
```
In `on_struct_payload`, read `data.intent` and gate: `if (!should_apply_push(data.intent, !!deps.get_structure())) return` before `apply_structure_event(data.structure)`.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat(bonds): viewer holds load pushes when it already has a structure"`

---

### Task 4: ChatPane — gate card on `intent:load`, add 覆盖 option

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte` (the load-card effect + card markup from PR #370)
- Modify: `src/lib/i18n/en/chat.ts`, `src/lib/i18n/zh/chat.ts`

**Interfaces:**
- Consumes: SSE `structure` event now carries `intent` (Task 1).
- Produces: new props `has_sibling_structure?: boolean`, `on_view_overwrite?: (panelId: string) => void`.

- [ ] **Step 1:** In ChatPane's SSE card effect, only surface the card when `JSON.parse(ev.data).intent === 'load'` (ignore edits). Keep the formula/dedup logic.
- [ ] **Step 2:** Add props `has_sibling_structure = false`, `on_view_overwrite = undefined` (+ types).
- [ ] **Step 3:** In the card markup, when `has_sibling_structure && on_view_overwrite`, render a first button:
```svelte
<button type="button" class="lsc-btn" onclick={() => { on_view_overwrite?.(loaded_view_card!.panelId); loaded_view_card = null }}>{t('chat.view_overwrite')}</button>
```
- [ ] **Step 4:** Add i18n `view_overwrite` to en (`⟳ Overwrite`) and zh (`⟳ 覆盖`).
- [ ] **Step 5:** `pnpm exec vitest run tests/vitest/i18n` (or the i18n parity test) — expect PASS (keys in parity).
- [ ] **Step 6: Commit** — `git commit -am "feat(chat): load-only card + overwrite option when a viewer exists"`

---

### Task 5: Hosts — pass `has_sibling_structure` + wire 覆盖 + docked chat

**Files:**
- Modify: `desktop/App.svelte` (standalone chat pane ChatPane ~line 2176)
- Modify: `src/lib/structure/Structure.svelte` (docked ChatPane ~line 4732/4746)

**Interfaces:** Consumes ChatPane props from Task 4.

- [ ] **Step 1 (App.svelte):** compute `has_sibling_structure` — does the tab have another structure leaf with content? `leaves(ts.root).some(l => l.id !== leaf.id && pane_has_content_for(l))`. Pass it. Add `on_view_overwrite={async () => { fetch /view/structure/current?panel_id=tab.id → find the tab's structure pane → pane.structure = clone_structure(struct); ... }}`.
- [ ] **Step 2 (Structure.svelte):** the docked ChatPane (right/bottom) ALWAYS sits beside the viewer → pass `has_sibling_structure={!!structure}`, `on_view_overwrite` = set THIS Structure's pane structure (reuse the import/load path), `on_view_split`/`on_view_new_window` mirroring App.svelte.
- [ ] **Step 3: Manual (chrome-devtools on :3100):** docked viewer with structure A → push a `load` (`?intent=load`) of B → card shows [覆盖|新pane|新窗口], A NOT overwritten. 覆盖 → A replaced by B. Push an `edit` (`intent=edit`) → applies in place, no card.
- [ ] **Step 4: Commit** — `git commit -am "feat(chat): wire overwrite/sibling-aware card on standalone + docked chat"`

---

## Self-Review
- **Spec coverage:** intent tag (T1), load-tool tagging (T2), viewer hold (T3), card 3rd option (T4), hosts + docked wiring + overwrite (T5). Client-direct path explicitly out of scope (spec). ✓
- **Types:** `intent: string|undefined`, `should_apply_push(intent, viewer_has_structure)`, `has_sibling_structure: boolean`, `on_view_overwrite(panelId)` consistent across tasks. ✓
- **Placeholders:** T1 test notes the real emit mechanism must be confirmed (the one soft spot — the implementer reads `notify_structure` first). T2/T5 require a grep to enumerate callers (load tools / sibling panes) — unavoidable, the grep commands are given.
