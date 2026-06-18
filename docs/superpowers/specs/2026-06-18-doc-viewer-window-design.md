# Document Viewer Window — Design

Date: 2026-06-18
Status: Approved (brainstorm), pending implementation plan

## Problem

Non-structure files (text, code, Markdown, CSV, PDF, images, Excel, Word …)
currently open as a **single-file, full-screen overlay** inside the main CatGo
window (the `sidebar.editor_*` editor and `sidebar.preview_*` preview blocks
rendered in `desktop/App.svelte`). Only one file is viewable at a time, the
overlay covers the workspace, and it cannot be moved to a second monitor.

We want a dedicated **multi-tab document viewer that lives in its own OS window**
so it can be dragged out of the main window onto a separate screen while CatGo's
3D workbench stays on the primary screen.

## Goals

- A single, reusable **OS-level window** (Tauri `WebviewWindow`) hosting a
  tabbed document viewer; draggable to any monitor, independent of the main
  window.
- Each opened file becomes a **new tab**; reopening a file focuses its existing
  tab instead of duplicating.
- v1 file types: plain text & source code, Markdown, CSV/TSV, PDF, images,
  Excel (xlsx/xls), **Word (docx)**.
- Editable types (text / code / Markdown) keep Monaco editing **with Save**;
  everything else is read-only.
- All existing non-structure open entry points route here: sidebar
  click (preview/edit), drag-drop, terminal Ctrl+click, HPC remote file.
- Renderer set is **pluggable** so PowerPoint (pptx) and others can be added
  later without reworking the shell.

## Non-Goals (v1)

- PowerPoint / pptx (deferred; plugs into the renderer map later).
- Multiple independent document windows (one reusable singleton only).
- Moving structure / trajectory files into this viewer — they keep using the
  main-window 3D pane tree.
- Collaborative / multi-user sync of the viewer.

## Architecture

A true OS window, following the established CatGo popout pattern
(`#structure` / `#chat` / `#terminal` routes opened via
`desktop/lib/popout-manager.ts`).

```
 main window (CatGo workbench)              docs window (catgo-docs)
 ───────────────────────────               ────────────────────────
 entry points ──► open_doc_window(ref) ──► #docs route → DocViewer.svelte
   sidebar / drag / terminal / HPC          │  doc-viewer-state (own store)
                                            │  tab strip + per-tab renderer
   (Tauri emit 'catgo-open-doc' | web        ▼
    BroadcastChannel 'catgo-docs')          resolves content via backend
                                            (read_file / readRemoteFile /
                                             readRemoteBinaryFile) or a
                                             one-shot localStorage handoff
```

### Components

**`src/lib/viewer/doc-viewer-state.svelte.ts`** (new) — the docs window's own
reactive singleton store (Svelte 5 runes). Holds:
- `tabs: DocTab[]`, `active_id: string | null`
- window-local UI prefs if any (active tab persistence)
- functions: `open_doc(ref)`, `close_tab(id)`, `activate(id)`, `mark_dirty(id)`

`DocTab`:
```ts
interface DocTab {
  id: string                 // stable id; dedupe key derived from ref
  filename: string
  kind: DocKind              // 'text'|'markdown'|'csv'|'pdf'|'image'|'excel'|'docx'
  editable: boolean          // text/markdown/code → true
  origin: { session_id: string; file_path: string } | null  // HPC remote
  local_path: string | null  // local filesystem path
  inline_key: string | null  // localStorage key for path-less content
  // loaded lazily by the renderer; not all carried in the ref
}
```

**`DocKind` resolver** — a **pure exported function** (its own small module,
e.g. `src/lib/viewer/doc-kind.ts`, not tied to the runes store) that maps a
filename extension / mime to `{ kind, editable }`. Imported by BOTH the
main-window entry points (to build the ref) and the docs window. Unknown
extension → `{ kind: 'text', editable: true }` (read in Monaco) with a download
affordance if content can't be decoded as text.

**`DocViewer.svelte`** (new) — full-window component rendered by the `#docs`
route. A tab strip (lightweight, styled like the existing pane TabBar but
local to this window) + the active tab body. The body selects a renderer by
`kind`:
- editable text/markdown/code → **`MonacoEditorPanel`** (existing) with Save
- csv / pdf / image / excel → **`FilePreviewPanel`** (existing)
- docx → **`DocxView.svelte`** (new): mammoth.js converts the ArrayBuffer to
  HTML, sanitized, rendered scrollable. Read-only.

**`DocxView.svelte`** (new) + `mammoth` dependency.

**`open_doc_window(ref)`** (new, in `desktop/lib/popout-manager.ts`) — the
cross-window entry used by the main window:
- Tauri: `WebviewWindow.getByLabel('catgo-docs')`; if present → `emit(
  'catgo-open-doc', ref)` + `setFocus`; else create the window at `#docs`, wait
  for ready, then emit.
- Web fallback: `window.open('#docs', 'catgo-docs')` + post the ref over
  `BroadcastChannel('catgo-docs')`.

### Data flow — opening a file

1. An entry point builds a lightweight `DocRef`:
   `{ filename, kind, origin | local_path, inline_key? }`.
   `kind` comes from the shared resolver.
2. Entry point calls `open_doc_window(ref)`.
3. The docs window receives the ref (Tauri event / BroadcastChannel) and calls
   `open_doc(ref)`. If a tab with the same dedupe key exists, it is focused;
   otherwise a new tab is appended and activated.
4. The tab's renderer resolves content **inside the docs window**:
   - `local_path` → backend `read_file` (text) / binary read for pdf/image/
     excel/docx
   - `origin` (HPC) → `readRemoteFile` / `readRemoteBinaryFile`
   - `inline_key` → read once from `localStorage` (path-less drops / in-memory
     content), then remove the key
5. Renderer displays; Monaco tabs track a `dirty` flag.

### Saving (editable tabs)

The docs window calls the existing backend save paths directly (local fs write /
HPC SFTP write) — the same APIs the current editor overlay uses. No round-trip
to the main window. On success, clear `dirty`.

### Entry-point rewiring

Replace the code that sets `sidebar.editor_*` / `sidebar.preview_*` with a
`open_doc_window(ref)` call, in:
- `desktop/lib/sidebar-handlers.ts` — `handle_sidebar_preview`,
  `handle_sidebar_open_editor`
- `desktop/lib/sidebar-handlers.ts` — `handle_terminal_open_file` (already
  branches by type; build a ref instead of preview/editor)
- drag-drop of non-structure files (`desktop/lib/drag-drop-handlers.ts`)
- HPC remote-file preview path
- Remove the now-dead editor/preview overlay render blocks in
  `desktop/App.svelte` and the `sidebar.editor_*` / `sidebar.preview_*` state if
  nothing else uses them.

Structure / trajectory files are unchanged — they still load into the main
window's 3D pane tree.

## Error Handling

- Unknown / undecodable type → read-only Monaco text view + a "download" action.
- docx parse failure → in-tab error message; tab stays closable.
- Backend content load failure → in-tab error with retry; never blank.
- Large files → reuse the existing size guards used by the current preview /
  editor and the trajectory streamer; do not read multi-hundred-MB files whole.
- Docs window creation failure (Tauri) → fall back to `window.open`.

## Testing

- **Unit:** `DocKind` resolver (extension/mime → kind + editable, incl. unknown
  fallback). doc-viewer-state `open_doc` (append, dedupe-focus, close, activate).
- **Unit:** `open_doc_window` ref dispatch — Tauri emit path vs web
  BroadcastChannel path (mock the transport).
- **Component smoke:** DocViewer renders a tab per kind and switches active tab;
  Monaco tab exposes Save, read-only tabs do not.
- Keep i18n en/zh parity for any new strings (tab labels, errors, empty state).

## Open / Deferred

- pptx: add a `pptx` kind + renderer later (server-side LibreOffice→PDF reusing
  the PDF tab is the leading candidate). The renderer map makes this additive.
  Reference: **mutyai/pptviewer** (https://github.com/mutyai/pptviewer, MIT) —
  a VS Code extension that does exactly this: LibreOffice headless converts
  .pptx/.ppt → PDF, then shows a PDF preview. Confirms the LibreOffice→PDF
  route; the trade-off is a LibreOffice dependency on the backend host. (It is
  NOT a client-side JS renderer.)
- Whether to persist the open tab set across app restarts (v1: no).
