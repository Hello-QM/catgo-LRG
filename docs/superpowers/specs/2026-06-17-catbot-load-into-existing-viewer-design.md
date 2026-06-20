# CatBot loads a structure into an existing viewer → ask where to put it

**Date:** 2026-06-17
**Status:** approved (design)
**Builds on:** 2026-06-17-catbot-load-structure-view-prompt-design.md (the
load→Split/New-window card, already shipped in PR #370).

## Problem

When a 3D viewer already shows a structure and CatBot **loads a new one**, the
new structure is pushed to the panel and the viewer's SSE handler
auto-applies it — silently **overwriting** what the user had. The user should
instead be asked where the new structure goes: **overwrite**, **new pane**, or
**new window**.

In-place EDITS (supercell, add/delete atom, doping, slab, …) must still apply
directly to the current structure — only fresh LOADS prompt.

## Design

### 1. Tag pushes load-vs-edit
Structure pushes gain an `intent: "load" | "edit"` field (default `"edit"`).
- Load tools — `fetch_crystal`/`fetch_molecule`/`load_optimade`/PubChem/
  build-from-scratch (reticular, nanotube-from-nothing, etc.) — push `intent:"load"`.
- Edit tools — supercell, add/delete/replace/move atom, doping, substitution,
  slab, strain, merge, heterostructure, etc. — push `intent:"edit"`.

Carried through `server/catgo/mcp_tools/helpers.py::_push_structure_to_viewer`
(new `intent` param) → `view_state.notify_structure(panel_id, struct, intent)`
→ the SSE `structure` event payload (`{structure, intent}`). The viewer's
`structure-info` and `current` stores are unchanged.

### 2. Viewer holds loads
`tool-handler.ts` SSE `structure` handler / Structure.svelte apply path:
if `intent === "load"` AND the viewer already has a non-empty structure →
**do not apply** (drop it; the backend store + the SSE payload still carry it
for the card). `intent === "edit"` (or an empty viewer) → apply as today.

### 3. Card: 3rd option + show in docked chat
ChatPane card (from PR #370) fires only on `intent === "load"` events.
- A new prop `has_sibling_structure?: boolean` (passed by the host) tells the
  card whether a viewer-with-structure already exists for this panel.
- `has_sibling_structure` true → card shows **[覆盖 | 新 pane | 新窗口]**.
- false → **[新 pane | 新窗口]** (PR #370 behavior, unchanged).
- Wire the card + handlers on BOTH the standalone chat pane (desktop/App.svelte)
  AND the docked chat (Structure.svelte) — the docked case is where a sibling
  viewer exists.

### 4. Actions
- **覆盖 (overwrite):** new prop `on_view_overwrite?(panelId)`. The host fetches
  `/view/structure/current?panel_id` and sets the existing viewer pane's
  `structure = clone_structure(struct)` (same as `handle_database_import`).
- **新 pane (split):** existing `on_view_split` (PR #370).
- **新窗口 (new window):** existing `on_view_new_window` (PR #370).

## Scope / files
- `server/catgo/mcp_tools/helpers.py` — `_push_structure_to_viewer(intent=...)`.
- The MCP load/edit tool handlers — pass `intent="load"` from load tools.
- `server/catgo/routers/view_state.py` — `notify_structure(..., intent)` + SSE payload.
- `src/lib/structure/controllers/tool-handler.ts` — hold `intent:"load"` when viewer non-empty.
- `src/lib/chat/ChatPane.svelte` — read `intent`, `has_sibling_structure`, 3rd button + `on_view_overwrite`.
- `desktop/App.svelte` + `src/lib/structure/Structure.svelte` — pass `has_sibling_structure` + `on_view_overwrite`; wire docked chat.

## Out of scope (follow-up)
- Client-direct provider path (`set_current_structure` in structure-tools.ts):
  same idea, separate change. The user uses SDK agents (MCP path), so MCP first.

## Testing
- pytest: `notify_structure`/push helper carries `intent`.
- vitest: viewer-hold predicate (load + non-empty viewer ⇒ hold; edit ⇒ apply).
- Manual (chrome-devtools on :3100): docked viewer with structure A → CatBot
  loads B → card shows 3 options, A NOT overwritten; 覆盖 replaces A; 新pane
  splits; 新窗口 opens. Edit (supercell) still applies in place (no card).
