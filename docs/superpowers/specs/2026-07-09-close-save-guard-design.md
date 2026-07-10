# Unsaved-changes guard + save-on-close (VS Code ext + desktop app)

**Date:** 2026-07-09
**Status:** approved (design)

## Problem

Editing a structure and closing its editor/tab currently loses the changes
silently — no "save changes?" prompt. Wanted in **both** surfaces:

- **VS Code extension** — closing a CatGo custom-editor tab (e.g. `IS_raw.xyz`).
- **Desktop app** — closing a structure tab/pane.

## Behaviour (both surfaces)

- Editing a structure marks it **modified** (dirty). The tab shows the standard
  dirty indicator.
- **Ctrl+S** → silently overwrite the source file, in the source file's format
  (xyz→xyz, POSCAR→POSCAR, …). Clears dirty. No dialog.
- **Save As** (Ctrl+Shift+S / a "Save As…" action) → native save dialog
  **pre-filled with the original file path**; keeping it overwrites, changing it
  renames/relocates. Becomes the new save target.
- **Close while dirty** → prompt **Save / Don't Save / Cancel**. Save →
  overwrite the source file. Cancel → abort the close.
- **Close while clean** (already Ctrl+S'd) → close silently, no prompt.
- **Save failure** → show an error, keep the tab open (do not close/lose edits).

## A. VS Code extension — `CustomEditorProvider` (extensions/vscode/src/extension.ts)

Currently `registerCustomEditorProvider` + `resolveCustomEditor` with a manual
`saveAs` webview message, but **no dirty tracking / save methods** — so VS Code
never prompts on close.

- **Webview (`src/webview/main.ts`)**: wire the mounted CatGo component's
  `on_structure_change` → `postMessage({ command: 'dirty' })`. On a
  `requestContent` message from the extension, serialize the current structure in
  the source format and reply `{ command: 'content', content, is_binary }`.
- **Extension**:
  - Per-document dirty flag + an `onDidChangeCustomDocument` emitter. On a
    `dirty` webview message → fire the emitter → VS Code marks the tab dirty and
    enables the native close prompt.
  - `saveCustomDocument(document)` → request content from that document's
    webview → `workspace.fs.writeFile(document.uri, content)` → clear dirty.
  - `saveCustomDocumentAs(document, targetResource)` → write content to
    `targetResource` (VS Code's Save As dialog supplies it, defaulting to the
    original). The existing `saveAs` message handler is kept for an explicit
    in-viewer "Save As…" button but routed through the same serialize path.
  - `backupCustomDocument(...)` → write a backup copy for hot-exit safety.
- Result: the native VS Code "save changes?" prompt, dirty dot, Ctrl+S overwrite,
  and Save As all work with zero custom dialogs.

## B. Desktop app — Tauri/Svelte (src/lib/structure/)

Pieces already present: `file_path`/`filename` on the loaded structure,
`io/fetch.ts` `save_with_dialog`, `io/export.ts` format serializers,
`DraggablePane.close_pane()` + tab close.

- Track `is_modified` per structure/tab: set `true` on `on_structure_change`,
  `false` after a successful save or a fresh load.
- Intercept tab/pane close (`close_pane` + the tab-bar close): if `is_modified`,
  show a confirm dialog **Save / Don't Save / Cancel**.
  - **Save** → `save_with_dialog` with `defaultPath = file_path`, content from
    `io/export` in the source format. Overwrites if the path is unchanged, saves
    a new file if changed. On success clear `is_modified` and close; on failure
    keep the tab.
  - **Don't Save** → close. **Cancel** → abort.
- Window close (`beforeunload`) → if any tab is `is_modified`, warn before exit.

## Testing

- **Ext**: unit-test the `dirty` message → `onDidChangeCustomDocument` wiring and
  the serialize-on-save path (mock the webview messaging). Manual: edit → dirty
  dot → close → prompt → Save writes the file; Save As renames.
- **App**: vitest for `is_modified` transitions and the close-guard decision
  (dirty → prompt, clean → silent). Manual: edit → close tab → prompt → Save via
  dialog defaulting to the original path.

## Out of scope

- Multi-select / bulk close prompts beyond the standard per-tab behavior.
- Auto-save / periodic backup beyond hot-exit `backupCustomDocument`.
- Changing the on-disk format on save (always save in the source format).
