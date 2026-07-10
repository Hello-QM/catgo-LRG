# Close/Save Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt to save (or Save As) when closing a structure with unsaved edits — in both the VS Code extension and the desktop app.

**Architecture:** Two independent subsystems, each shippable on its own. **Part A** flips the VS Code custom editor from readonly to editable so VS Code's native dirty/close-prompt/Ctrl+S/Save-As machinery applies, driven by a `dirty` message the webview emits on edit. **Part B** adds a per-tab `is_modified` flag in the desktop app and a close-guard confirm dialog that saves via the existing `save_with_dialog` + `export` serializers.

**Tech Stack:** VS Code Extension API (CustomEditorProvider), Svelte 5 runes, Tauri, vitest.

## Global Constraints

- Save in the SOURCE file's format (xyz→xyz, POSCAR→POSCAR, …) — never change format on save.
- Ctrl+S / close-prompt "Save" → silently overwrite the source file (no dialog). Save As → dialog pre-filled with the original path. Close while clean → no prompt.
- Save failure → surface an error and keep the tab open (do not close / lose edits).
- Ext formatting: no local `deno fmt` on `.ts` under extensions/vscode (that dir has its own build); match surrounding style (single quotes, no semicolons where the file already omits them).
- App formatting enforced by pre-commit `deno fmt` (single quotes, no semicolons, 2-space, 90-col); `.svelte` excluded. Let the hook format, re-stage.
- vitest lives under `tests/vitest/**` or `src/**/__tests__/**` only (CI ignores co-located `*.test.ts`). Run via `rtk proxy pnpm exec vitest run …`.

---

# Part A — VS Code extension

Current: `extensions/vscode/src/extension.ts` registers a
`CustomReadonlyEditorProvider` (class `Provider`, line ~885) whose
`openCustomDocument` returns a bare `{ uri, dispose }`. The webview
(`src/webview/main.ts`) already intercepts the frontend's `download()` and posts
`{ command: 'saveAs', content, is_binary, filename }` (see `setup_vscode_download`,
~line 276). There is NO dirty tracking or save method, so VS Code never prompts.

### Task A1: Webview emits `dirty` on edit + answers `requestContent`

**Files:**
- Modify: `extensions/vscode/src/webview/main.ts` (Structure mount props ~line 693; message-in handler)

**Interfaces:**
- Produces: webview → ext message `{ command: 'dirty' }` (fired on each structure edit); webview handles ext → webview message `{ command: 'requestContent', request_id }` by replying `{ command: 'content', request_id, content, is_binary, filename }` using the same serializer the existing `saveAs` path uses.

- [ ] **Step 1: Pass `on_structure_change` into the Structure mount so edits notify the host**

In `create_display`/the `mount(Component, { target, props })` call (~line 693), add to `props` (only for the non-trajectory Structure component):

```ts
on_structure_change: () => {
  vscode_api?.postMessage({ command: `dirty` })
},
```

(`vscode_api` is already acquired at ~line 261. `Structure.svelte` already invokes `on_structure_change` on every edit — verified.)

- [ ] **Step 2: Reuse the export serializer to answer content requests**

Find where `setup_vscode_download` builds the `saveAs` payload (~line 276-289). Extract the "serialize current structure to text/base64 for the current filename" into a reusable function in this file:

```ts
// Serialize whatever the frontend's export/download would produce for the
// active structure. Mirrors the intercepted-download path used by `saveAs`.
async function serialize_current(): Promise<
  { content: string; is_binary: boolean; filename: string } | null
> {
  // Trigger the same in-app export the download override captures. If the app
  // exposes a direct export API on the mounted component, call it; otherwise
  // reuse the captured `saveAs` payload cached by setup_vscode_download.
  return _last_export_payload ?? null
}
```

Add a module-level `let _last_export_payload: {content,is_binary,filename} | null = null` and, inside `setup_vscode_download`'s intercept, set `_last_export_payload = { content, is_binary, filename }` right before it posts `saveAs`. Also expose an explicit "export now" trigger: call the same code path the download button uses (the frontend `download()` for the current structure) so content is fresh on request.

- [ ] **Step 3: Handle `requestContent` from the extension**

In the webview's `window.addEventListener('message', …)` handler (where FileChangeMessage etc. are handled), add:

```ts
if (msg.command === `requestContent`) {
  const payload = await serialize_current()
  vscode_api?.postMessage({
    command: `content`,
    request_id: msg.request_id,
    content: payload?.content ?? ``,
    is_binary: payload?.is_binary ?? false,
    filename: payload?.filename ?? ``,
  })
  return
}
```

- [ ] **Step 4: Build + smoke check the webview bundle**

Run: `cd extensions/vscode && pnpm run build` (or the ext's bundle script).
Expected: builds with no type error; `dist/` updated.

- [ ] **Step 5: Commit**

```bash
git add extensions/vscode/src/webview/main.ts
git commit -m "feat(vscode): webview emits dirty on edit + answers requestContent"
```

### Task A2: Provider becomes editable — dirty tracking + save methods

**Files:**
- Modify: `extensions/vscode/src/extension.ts` (class `Provider` ~885; message handler ~925; registration ~998)
- Test: `extensions/vscode/src/__tests__/provider-save.test.ts` (new)

**Interfaces:**
- Consumes: webview `dirty` and `content` messages from Task A1.
- Produces: `Provider implements vscode.CustomEditorProvider<CatgoDocument>` with `onDidChangeCustomDocument`, `saveCustomDocument`, `saveCustomDocumentAs`, `revertCustomDocument`, `backupCustomDocument`; a `CatgoDocument` class exposing `uri`, `requestContent(): Promise<{content,is_binary}>` (round-trips `requestContent`/`content` with the panel's webview).

- [ ] **Step 1: Write the failing test for the document dirty/save wiring**

Create `extensions/vscode/src/__tests__/provider-save.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { CatgoDocument } from '../extension'

describe('CatgoDocument', () => {
  it('marks dirty on a dirty signal and clears after save', async () => {
    const uri = { fsPath: '/tmp/IS_raw.xyz' } as any
    const writes: Array<[string, Uint8Array]> = []
    const doc = new CatgoDocument(uri, {
      requestContent: async () => ({ content: 'XYZ...', is_binary: false }),
      writeFile: async (u: any, data: Uint8Array) => { writes.push([u.fsPath, data]) },
    })
    const changed = vi.fn()
    doc.onDidChange(changed)
    doc.signalEdit()
    expect(changed).toHaveBeenCalledTimes(1)
    await doc.save()
    expect(writes[0][0]).toBe('/tmp/IS_raw.xyz')
    expect(new TextDecoder().decode(writes[0][1])).toBe('XYZ...')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run extensions/vscode/src/__tests__/provider-save.test.ts`
Expected: FAIL — `CatgoDocument` not exported.

- [ ] **Step 3: Add the `CatgoDocument` class (testable, VS-Code-free core)**

In `extension.ts`, add and export:

```ts
export interface DocDeps {
  requestContent: () => Promise<{ content: string; is_binary: boolean }>
  writeFile: (uri: vscode.Uri, data: Uint8Array) => Promise<void>
}

export class CatgoDocument implements vscode.CustomDocument {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event
  constructor(public readonly uri: vscode.Uri, private deps: DocDeps) {}
  signalEdit(): void { this._onDidChange.fire() }
  async save(target: vscode.Uri = this.uri): Promise<void> {
    const { content, is_binary } = await this.deps.requestContent()
    const data = is_binary
      ? Uint8Array.from(Buffer.from(content.replace(/^data:[^;]+;base64,/, ``), `base64`))
      : new TextEncoder().encode(content)
    await this.deps.writeFile(target, data)
  }
  dispose(): void { this._onDidChange.dispose() }
}
```

(`vscode.EventEmitter` is imported already via `import * as vscode`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run extensions/vscode/src/__tests__/provider-save.test.ts`
Expected: PASS. (In the test, `vscode` is the mocked module under `src/mocks/` — add a minimal `EventEmitter` if the mock lacks one.)

- [ ] **Step 5: Convert `Provider` to `CustomEditorProvider` and wire the panel**

Change the class header:

```ts
class Provider implements vscode.CustomEditorProvider<CatgoDocument> {
  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CatgoDocument>>()
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event
  private panels = new Map<string, vscode.WebviewPanel>()  // by uri.toString()
```

`openCustomDocument` returns a `CatgoDocument` whose `DocDeps.requestContent`
round-trips the webview and whose `writeFile` is `vscode.workspace.fs.writeFile`:

```ts
openCustomDocument(uri: vscode.Uri): CatgoDocument {
  const doc = new CatgoDocument(uri, {
    requestContent: () => this.requestContentFor(uri),
    writeFile: (u, data) => Promise.resolve(vscode.workspace.fs.writeFile(u, data)),
  })
  doc.onDidChange(() =>
    this._onDidChangeCustomDocument.fire({
      document: doc,
      undo: async () => {}, redo: async () => {},   // structural undo lives in-webview
      label: `Edit`,
    }))
  return doc
}
```

In `resolveCustomEditor`, store the panel (`this.panels.set(document.uri.toString(), webview_panel)`; clear on `onDidDispose`). In the existing `onDidReceiveMessage` handler (~line 925) add:

```ts
if (msg.command === `dirty`) { document.signalEdit(); return }
```

Add `requestContentFor(uri)` that posts `{command:'requestContent', request_id}` to that uri's panel and resolves on the matching `{command:'content', request_id}` message (Promise keyed by request_id).

Implement the provider save methods:

```ts
saveCustomDocument(document: CatgoDocument): Thenable<void> { return document.save() }
saveCustomDocumentAs(document: CatgoDocument, dest: vscode.Uri): Thenable<void> {
  return document.save(dest)
}
revertCustomDocument(document: CatgoDocument): Thenable<void> {
  this.panels.get(document.uri.toString())?.webview.postMessage({ command: `revert` })
  return Promise.resolve()
}
async backupCustomDocument(document: CatgoDocument, ctx: vscode.CustomDocumentBackupContext) {
  await document.save(ctx.destination)
  return { id: ctx.destination.toString(), delete: () =>
    vscode.workspace.fs.delete(ctx.destination).then(() => {}, () => {}) }
}
```

- [ ] **Step 6: Update the registration for editable + type-check**

Registration (~line 998) stays `registerCustomEditorProvider(catgo.viewer, new Provider(context), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false })`. Ensure package.json `contributes.customEditors[0]` (viewType `catgo.viewer`) is unchanged (editable uses the same contribution).

Run: `cd extensions/vscode && pnpm run build`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add extensions/vscode/src/extension.ts extensions/vscode/src/__tests__/provider-save.test.ts
git commit -m "feat(vscode): editable custom editor — dirty tracking + save/saveAs/backup"
```

### Task A3: Live-verify the extension in VS Code

**Files:** none (verification only).

- [ ] **Step 1: Rebuild + launch the Extension Development Host**

Run: `cd extensions/vscode && pnpm run build`, then F5 (or `code --extensionDevelopmentPath=.`).

- [ ] **Step 2: Exercise the flow**

Open a `*.xyz`/`CONTCAR` in the CatGo editor; edit atoms → the tab shows the dirty dot. `Ctrl+S` → file overwritten, dot clears. Edit again → close the tab → native "Do you want to save?" appears; Save writes the file. `Ctrl+Shift+S` → Save As dialog pre-filled with the original path; renaming writes a new file. Closing a clean (saved) tab shows no prompt.

- [ ] **Step 3: Report** — confirm each behavior to the user.

---

# Part B — Desktop app

Pieces present: the loaded structure carries `filename`/`file_path`
(Structure.svelte ~4107-5453); `src/lib/io/fetch.ts` exports `save_with_dialog`;
`src/lib/io/export.ts` serializes every format via `download(...)`;
`DraggablePane.close_pane()` (~line 142) + the tab-bar close the panes/tabs.

### Task B1: Per-tab `is_modified` state + helper

**Files:**
- Create: `src/lib/structure/close-guard.svelte.ts`
- Test: `tests/vitest/structure/close-guard.test.ts` (new)

**Interfaces:**
- Produces: `create_modified_registry()` → `{ mark(tab_id: string): void; clear(tab_id: string): void; is_modified(tab_id: string): boolean; any_modified(): boolean }` backed by a `SvelteSet`.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/structure/close-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { create_modified_registry } from '$lib/structure/close-guard.svelte'

describe('modified registry', () => {
  it('tracks dirty tabs and clears on save', () => {
    const r = create_modified_registry()
    expect(r.is_modified('t1')).toBe(false)
    r.mark('t1')
    expect(r.is_modified('t1')).toBe(true)
    expect(r.any_modified()).toBe(true)
    r.clear('t1')
    expect(r.is_modified('t1')).toBe(false)
    expect(r.any_modified()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/close-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/lib/structure/close-guard.svelte.ts`:

```ts
import { SvelteSet } from 'svelte/reactivity'

export function create_modified_registry() {
  const dirty = new SvelteSet<string>()
  return {
    mark: (tab_id: string) => dirty.add(tab_id),
    clear: (tab_id: string) => dirty.delete(tab_id),
    is_modified: (tab_id: string) => dirty.has(tab_id),
    any_modified: () => dirty.size > 0,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/close-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/close-guard.svelte.ts tests/vitest/structure/close-guard.test.ts
git commit -m "feat(viewer): per-tab modified registry for the close guard"
```

### Task B2: Mark modified on edit; wire the registry into the tab owner

**Files:**
- Modify: the component that owns the tab list + renders `Structure` per tab (find via `rtk proxy grep -rln "close_pane\|Structure.svelte\|active_tab" src` — likely `src/App.svelte` / `src/lib/DraggablePane.svelte` / the workspace component)
- Modify: `src/lib/structure/Structure.svelte` (ensure an `on_structure_change` prop is forwarded to the owner; it already exists internally)

**Interfaces:**
- Consumes: `create_modified_registry()` from Task B1.
- Produces: each mounted `Structure` calls `registry.mark(tab_id)` on `on_structure_change`; a successful save or fresh load calls `registry.clear(tab_id)`.

- [ ] **Step 1: Instantiate the registry once in the tab owner**

In the workspace/tab-owner component, `const modified = create_modified_registry()` and pass `on_structure_change={() => modified.mark(tab_id)}` to each `<Structure>` (Structure.svelte already fires it on edits).

- [ ] **Step 2: Clear on load**

Where a structure is loaded/replaced for a tab (file open, push, revert), call `modified.clear(tab_id)`.

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(viewer): mark tab modified on edit, clear on load"
```

### Task B3: Close-guard confirm + save on tab/pane close

**Files:**
- Create: `src/lib/structure/save-on-close.ts`
- Modify: the tab-close + `DraggablePane.close_pane()` (~line 142) call sites
- Test: `tests/vitest/structure/save-on-close.test.ts` (new)

**Interfaces:**
- Consumes: `modified.is_modified(tab_id)`, `save_with_dialog` (io/fetch), the structure's `file_path`, `export`-format serializer.
- Produces: `async function guard_close(opts: { modified: boolean; on_save: () => Promise<boolean>; confirm: () => Promise<'save'|'discard'|'cancel'> }): Promise<boolean>` — returns `true` if the caller should proceed to close, `false` to abort.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/structure/save-on-close.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { guard_close } from '$lib/structure/save-on-close'

describe('guard_close', () => {
  it('clean tab closes without prompting', async () => {
    const confirm = vi.fn()
    expect(await guard_close({ modified: false, on_save: vi.fn(), confirm })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('save → runs save, closes when save succeeds', async () => {
    const on_save = vi.fn().mockResolvedValue(true)
    expect(await guard_close({ modified: true, on_save,
      confirm: async () => 'save' })).toBe(true)
    expect(on_save).toHaveBeenCalled()
  })
  it('save failure keeps the tab open', async () => {
    expect(await guard_close({ modified: true, on_save: async () => false,
      confirm: async () => 'save' })).toBe(false)
  })
  it('discard closes, cancel aborts', async () => {
    expect(await guard_close({ modified: true, on_save: vi.fn(),
      confirm: async () => 'discard' })).toBe(true)
    expect(await guard_close({ modified: true, on_save: vi.fn(),
      confirm: async () => 'cancel' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/save-on-close.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `guard_close`**

Create `src/lib/structure/save-on-close.ts`:

```ts
export async function guard_close(opts: {
  modified: boolean
  on_save: () => Promise<boolean>
  confirm: () => Promise<`save` | `discard` | `cancel`>
}): Promise<boolean> {
  if (!opts.modified) return true
  const choice = await opts.confirm()
  if (choice === `cancel`) return false
  if (choice === `discard`) return true
  return opts.on_save() // true = saved → close; false = save failed → keep open
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/save-on-close.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `guard_close` into the close call sites**

At each tab-close and `DraggablePane.close_pane()`, make the handler `async` and gate the actual close:

```ts
const proceed = await guard_close({
  modified: modified.is_modified(tab_id),
  confirm: async () => {
    const r = await confirm_dialog({
      message: `Save changes to ${filename}?`,
      buttons: [`Save`, `Don't Save`, `Cancel`],
    })
    return r === `Save` ? `save` : r === `Don't Save` ? `discard` : `cancel`
  },
  on_save: async () => {
    try {
      await save_with_dialog(serialize_structure(structure, file_path), {
        defaultPath: file_path, filename,
      })
      modified.clear(tab_id)
      return true
    } catch (e) {
      show_error(`Save failed: ${e}`)
      return false
    }
  },
})
if (!proceed) return
// … existing close logic …
```

Use the app's existing confirm-dialog helper (find it near CloseAllModal / the existing "Continue" prompts) and `serialize_structure` = the `export.ts` serializer for the structure's source format. `save_with_dialog` from `$lib/io/fetch`.

- [ ] **Step 6: Type-check + full unit suite**

Run: `pnpm check` (0 errors), then `rtk proxy pnpm exec vitest run` (all green incl. the two new tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(viewer): confirm + save on closing a modified structure tab"
```

### Task B4: Window-close warning + live verify

**Files:**
- Modify: the app root (`src/App.svelte` or the Tauri window setup) for `beforeunload`

- [ ] **Step 1: Warn on window close when any tab is modified**

In the app root, add a `beforeunload` handler (web) / Tauri `onCloseRequested` (desktop) that, if `modified.any_modified()`, prompts before exit (reuse the confirm helper; on desktop, `event.preventDefault()` then run the same guard).

- [ ] **Step 2: Live-verify (desktop:dev)**

Load a structure from a file, edit it, close the tab → confirm dialog; Save → `save_with_dialog` defaults to the original path; overwrite works, rename works; Don't Save closes; Cancel aborts. Clean tab closes silently. Screenshot each for the user.

- [ ] **Step 3: Report** — show the user the results.
