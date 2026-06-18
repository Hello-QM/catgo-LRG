# CatBot "loaded a structure → view it" prompt

**Date:** 2026-06-17
**Status:** approved (design)

## Problem

When CatBot runs in a standalone chat pane (`initial_panel: 'chat'`, no 3D
viewer), a structure it loads (e.g. "加载 TiO2") is pushed to the backend panel
store but has no live viewer to render it. CatBot says "已显示在视图中" yet the
user sees nothing. They need a way to actually view what CatBot loaded.

## Behaviour

Every time CatBot loads/pushes a structure into the chat's panel, show a
non-blocking inline card in the chat offering two ways to view it:

> 📦 已加载 **<formula>** (<n> atoms) — [ ⊟ 分屏查看 ] [ ⧉ 新窗口 ]

- **分屏查看 (split):** split the current chat leaf into **left = 3D structure
  viewer** (bound to the chat's `panel_id`) **+ right = the chat** (kept).
- **新窗口 (new window):** open a separate window showing the structure.

(User chose: prompt on *every* load, even when a viewer is already docked. The
card is non-blocking and dismissible, so it never interrupts. "分屏" when a
sibling viewer already exists just focuses/keeps it.)

## Design

### 1. Detection (ChatPane)
Subscribe to the existing push channel `GET /view/subscribe?panel_id=<tab_id>`
(EventSource — same stream the viewer's `tool-handler` uses). On a
structure-push event, fetch `/view/structure/current?panel_id` for the formula
+ atom count and surface the card. Dedup by structure fingerprint so one load
shows one card. Tool-agnostic — works for `catgo_fetch`, build, load, etc.

### 2. Prompt UI (ChatPane)
A lightweight card component appended below the message list (not a modal).
Two buttons call new props `on_view_split?(panelId)` / `on_view_new_window?(panelId)`.
Dismiss (✕) hides it. Only the most recent card is shown.

### 3. Split action (desktop/App.svelte)
Use the recursive pane-tree split API to split the chat leaf horizontally:
left leaf = a Structure pane whose `panel_id`/`tab_id` matches the chat; on
mount it pulls `/view/structure/current?panel_id` so it renders the
already-pushed structure. Right leaf = the existing chat. Mirrors the existing
docked-chat layout (viewer + side chat).

### 4. New-window action (desktop/App.svelte)
Reuse the existing structure popout path (`load_popout_structure` / `#structure`
hash + Tauri `WebviewWindow`, `window.open` fallback) so the new window loads
the panel's structure.

## Scope
Desktop FE only:
- `src/lib/chat/ChatPane.svelte` — SSE detect + card + two new optional props.
- `desktop/App.svelte` — wire `on_view_split` / `on_view_new_window` on the
  standalone chat pane to the pane-tree split + structure popout.
- New viewer pane pulls the structure on mount (small `/view/structure/current`
  fetch; reuse existing load path).

No backend change — the structure is already in the panel store. The other
ChatPane mounts (docked in Structure.svelte, popout window) pass no handlers, so
they keep current behaviour.

## Testing
- vitest: the detection dedup helper (one card per distinct structure push).
- Manual: full-pane CatBot "加载 TiO2" → card → 分屏 shows viewer+chat; 新窗口
  opens a window with TiO2.
