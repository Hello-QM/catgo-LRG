# Document Viewer Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable OS-level window (Tauri `WebviewWindow` at `#docs`) hosting a multi-tab viewer for non-structure files (text/code, Markdown, CSV, PDF, image, Excel, Word), draggable to a second monitor, replacing the single-file editor/preview overlay.

**Architecture:** A pure kind-resolver + a window-local runes store drive a full-window `DocViewer.svelte` rendered by a new `#docs` route. Main-window entry points build a lightweight `DocRef` and call `open_doc_window(ref)`, which ensures the `catgo-docs` window exists and delivers the ref (Tauri global event + a localStorage drain-queue for the create-race; `BroadcastChannel` in web). The docs window resolves file content itself via existing backend read APIs. Renderers (Monaco / FilePreviewPanel / new DocxView) are chosen from a `kind→component` map.

**Tech Stack:** Svelte 5 runes, Tauri 2 (`@tauri-apps/api/webviewWindow`, `@tauri-apps/api/event`), Vitest, `mammoth` (new, docx→HTML).

## Global Constraints

- Formatting (enforced by hook; write by hand here — no `deno fmt`): single quotes, **no semicolons**, 2-space indent, backtick strings where the file already uses them.
- Svelte 5 runes only (`$state`/`$derived`/`$effect`/`$props`) — no stores, no `export let`.
- i18n: keep `src/lib/i18n/en` and `src/lib/i18n/zh` key sets in parity.
- CI gate is `pnpm test` (vitest). Keep `pnpm check` at 0 errors.
- Reuse existing components verbatim where possible: `FilePreviewPanel` (`mode: 'image'|'pdf'|'markdown'|'csv'|'excel'|'text'`), `MonacoEditorPanel` (`onsave`/`onchange`/`readonly`).
- Structure/trajectory files are OUT of scope — they keep loading into the main-window 3D pane tree. This viewer is non-structure files only.

---

### Task 1: DocKind resolver (pure function)

**Files:**
- Create: `src/lib/viewer/doc-kind.ts`
- Test: `tests/vitest/viewer/doc-kind.test.ts`

**Interfaces:**
- Produces: `type DocKind = 'text' | 'markdown' | 'csv' | 'pdf' | 'image' | 'excel' | 'docx'`; `interface DocKindInfo { kind: DocKind; editable: boolean; preview_mode: 'image'|'pdf'|'markdown'|'csv'|'excel'|'text' | null }`; `function resolve_doc_kind(filename: string, mime?: string): DocKindInfo`.
- `preview_mode` is the `FilePreviewPanel` mode for preview kinds, or `null` for kinds that don't use it (`text` editable → Monaco, `docx` → DocxView). Note `text` appears both as an editable Monaco kind and as a FilePreviewPanel fallback mode; here editable text uses Monaco so `preview_mode` is `null` for `kind:'text'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/viewer/doc-kind.test.ts
import { describe, it, expect } from 'vitest'
import { resolve_doc_kind } from '../../../src/lib/viewer/doc-kind'

describe('resolve_doc_kind', () => {
  it('maps editable text/code/markdown', () => {
    expect(resolve_doc_kind('a.txt')).toEqual({ kind: 'text', editable: true, preview_mode: null })
    expect(resolve_doc_kind('main.py')).toEqual({ kind: 'text', editable: true, preview_mode: null })
    expect(resolve_doc_kind('README.md')).toEqual({ kind: 'markdown', editable: true, preview_mode: 'markdown' })
  })
  it('maps read-only preview kinds', () => {
    expect(resolve_doc_kind('t.csv')).toEqual({ kind: 'csv', editable: false, preview_mode: 'csv' })
    expect(resolve_doc_kind('d.pdf')).toEqual({ kind: 'pdf', editable: false, preview_mode: 'pdf' })
    expect(resolve_doc_kind('p.png')).toEqual({ kind: 'image', editable: false, preview_mode: 'image' })
    expect(resolve_doc_kind('s.xlsx')).toEqual({ kind: 'excel', editable: false, preview_mode: 'excel' })
    expect(resolve_doc_kind('r.docx')).toEqual({ kind: 'docx', editable: false, preview_mode: null })
  })
  it('falls back unknown extensions to editable text', () => {
    expect(resolve_doc_kind('weird.zzz')).toEqual({ kind: 'text', editable: true, preview_mode: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/doc-kind.test.ts`
Expected: FAIL — cannot resolve module `doc-kind`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/viewer/doc-kind.ts
export type DocKind = 'text' | 'markdown' | 'csv' | 'pdf' | 'image' | 'excel' | 'docx'
export type PreviewMode = 'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'

export interface DocKindInfo {
  kind: DocKind
  editable: boolean
  preview_mode: PreviewMode | null
}

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i
const EXCEL = /\.(xlsx?|xlsm|xlsb|ods)$/i
const CSV = /\.(csv|tsv)$/i
const MD = /\.(md|markdown|rst)$/i

export function resolve_doc_kind(filename: string, _mime?: string): DocKindInfo {
  const name = filename.toLowerCase()
  if (IMAGE.test(name)) return { kind: 'image', editable: false, preview_mode: 'image' }
  if (/\.pdf$/i.test(name)) return { kind: 'pdf', editable: false, preview_mode: 'pdf' }
  if (EXCEL.test(name)) return { kind: 'excel', editable: false, preview_mode: 'excel' }
  if (CSV.test(name)) return { kind: 'csv', editable: false, preview_mode: 'csv' }
  if (MD.test(name)) return { kind: 'markdown', editable: true, preview_mode: 'markdown' }
  if (/\.docx?$/i.test(name)) return { kind: 'docx', editable: false, preview_mode: null }
  // Everything else (txt, source code, unknown) → editable plain text in Monaco.
  return { kind: 'text', editable: true, preview_mode: null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/doc-kind.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer/doc-kind.ts tests/vitest/viewer/doc-kind.test.ts
git commit -m "feat(viewer): DocKind resolver for the document viewer"
```

---

### Task 2: doc-viewer-state store (tabs)

**Files:**
- Create: `src/lib/viewer/doc-viewer-state.svelte.ts`
- Test: `tests/vitest/viewer/doc-viewer-state.test.ts`

**Interfaces:**
- Consumes: `DocKind` from `doc-kind.ts`.
- Produces:
  - `interface DocRef { filename: string; kind: DocKind; editable: boolean; origin: { session_id: string; file_path: string } | null; local_path: string | null; inline_key: string | null }`
  - `interface DocTab extends DocRef { id: string; dirty: boolean }`
  - `const doc_viewer = $state<{ tabs: DocTab[]; active_id: string | null }>(...)`
  - `function open_doc(ref: DocRef): string` (returns tab id; dedupes by `dedupe_key`)
  - `function close_tab(id: string): void`
  - `function activate(id: string): void`
  - `function set_dirty(id: string, dirty: boolean): void`
  - `function dedupe_key(ref: { origin: DocRef['origin']; local_path: string | null; inline_key: string | null; filename: string }): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/viewer/doc-viewer-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { doc_viewer, open_doc, close_tab, activate, set_dirty } from '../../../src/lib/viewer/doc-viewer-state.svelte'
import type { DocRef } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const ref = (over: Partial<DocRef> = {}): DocRef => ({
  filename: 'a.txt', kind: 'text', editable: true,
  origin: null, local_path: '/tmp/a.txt', inline_key: null, ...over,
})

beforeEach(() => { doc_viewer.tabs = []; doc_viewer.active_id = null })

describe('doc-viewer-state', () => {
  it('appends a tab and activates it', () => {
    const id = open_doc(ref())
    expect(doc_viewer.tabs).toHaveLength(1)
    expect(doc_viewer.active_id).toBe(id)
  })
  it('dedupes the same file to one tab and focuses it', () => {
    const id1 = open_doc(ref())
    const id2 = open_doc(ref({ filename: 'b.txt', local_path: '/tmp/b.txt' }))
    const id1b = open_doc(ref()) // same local_path as id1
    expect(doc_viewer.tabs).toHaveLength(2)
    expect(id1b).toBe(id1)
    expect(doc_viewer.active_id).toBe(id1)
    expect(id2).not.toBe(id1)
  })
  it('close removes a tab and re-activates a neighbor', () => {
    const a = open_doc(ref())
    const b = open_doc(ref({ filename: 'b.txt', local_path: '/tmp/b.txt' }))
    close_tab(b)
    expect(doc_viewer.tabs.map(t => t.id)).toEqual([a])
    expect(doc_viewer.active_id).toBe(a)
  })
  it('set_dirty flags the tab', () => {
    const a = open_doc(ref())
    set_dirty(a, true)
    expect(doc_viewer.tabs[0].dirty).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/doc-viewer-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/viewer/doc-viewer-state.svelte.ts
import type { DocKind } from './doc-kind'

export interface DocRef {
  filename: string
  kind: DocKind
  editable: boolean
  origin: { session_id: string; file_path: string } | null
  local_path: string | null
  inline_key: string | null
}

export interface DocTab extends DocRef {
  id: string
  dirty: boolean
}

export const doc_viewer = $state<{ tabs: DocTab[]; active_id: string | null }>({
  tabs: [],
  active_id: null,
})

export function dedupe_key(ref: Pick<DocRef, 'origin' | 'local_path' | 'inline_key' | 'filename'>): string {
  if (ref.origin) return `hpc:${ref.origin.session_id}:${ref.origin.file_path}`
  if (ref.local_path) return `local:${ref.local_path}`
  if (ref.inline_key) return `inline:${ref.inline_key}`
  return `name:${ref.filename}`
}

let _seq = 0
function next_id(): string {
  _seq += 1
  return `doc-${_seq}`
}

export function open_doc(ref: DocRef): string {
  const key = dedupe_key(ref)
  const existing = doc_viewer.tabs.find((t) => dedupe_key(t) === key)
  if (existing) {
    doc_viewer.active_id = existing.id
    return existing.id
  }
  const tab: DocTab = { ...ref, id: next_id(), dirty: false }
  doc_viewer.tabs = [...doc_viewer.tabs, tab]
  doc_viewer.active_id = tab.id
  return tab.id
}

export function activate(id: string): void {
  if (doc_viewer.tabs.some((t) => t.id === id)) doc_viewer.active_id = id
}

export function close_tab(id: string): void {
  const idx = doc_viewer.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  doc_viewer.tabs = doc_viewer.tabs.filter((t) => t.id !== id)
  if (doc_viewer.active_id === id) {
    const neighbor = doc_viewer.tabs[idx] ?? doc_viewer.tabs[idx - 1] ?? null
    doc_viewer.active_id = neighbor ? neighbor.id : null
  }
}

export function set_dirty(id: string, dirty: boolean): void {
  const t = doc_viewer.tabs.find((x) => x.id === id)
  if (t) t.dirty = dirty
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/doc-viewer-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer/doc-viewer-state.svelte.ts tests/vitest/viewer/doc-viewer-state.test.ts
git commit -m "feat(viewer): doc-viewer tab store with dedupe"
```

---

### Task 3: cross-window doc channel (send / subscribe + create-race queue)

**Files:**
- Create: `src/lib/viewer/doc-channel.ts`
- Test: `tests/vitest/viewer/doc-channel.test.ts`

**Interfaces:**
- Consumes: `DocRef` from `doc-viewer-state.svelte`.
- Produces:
  - `function enqueue_pending(ref: DocRef): void` — push to `localStorage` key `catgo-docs-pending` (JSON array).
  - `function drain_pending(): DocRef[]` — read + clear the queue (used by the docs window on mount).
  - `async function send_open_doc(ref: DocRef, is_tauri: boolean): Promise<void>` — live delivery: Tauri global `emit('catgo-open-doc', ref)` or `BroadcastChannel('catgo-docs').postMessage(ref)`.
  - `function on_open_doc(cb: (ref: DocRef) => void, is_tauri: boolean): () => void` — subscribe; returns unsubscribe. Tauri `listen('catgo-open-doc')` or BroadcastChannel `onmessage`.

- [ ] **Step 1: Write the failing test** (queue is the pure, testable core)

```ts
// tests/vitest/viewer/doc-channel.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue_pending, drain_pending } from '../../../src/lib/viewer/doc-channel'
import type { DocRef } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const ref = (n: string): DocRef => ({
  filename: n, kind: 'text', editable: true, origin: null, local_path: `/tmp/${n}`, inline_key: null,
})

beforeEach(() => localStorage.clear())

describe('doc-channel pending queue', () => {
  it('enqueues and drains in order, then clears', () => {
    enqueue_pending(ref('a.txt'))
    enqueue_pending(ref('b.txt'))
    const drained = drain_pending()
    expect(drained.map(r => r.filename)).toEqual(['a.txt', 'b.txt'])
    expect(drain_pending()).toEqual([])
  })
  it('drain on empty returns []', () => {
    expect(drain_pending()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/doc-channel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/viewer/doc-channel.ts
import type { DocRef } from './doc-viewer-state.svelte'

const PENDING_KEY = `catgo-docs-pending`
const CHANNEL = `catgo-docs`
const EVENT = `catgo-open-doc`

export function enqueue_pending(ref: DocRef): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const arr: DocRef[] = raw ? JSON.parse(raw) : []
    arr.push(ref)
    localStorage.setItem(PENDING_KEY, JSON.stringify(arr))
  } catch {
    // Non-fatal: the live channel still delivers to an already-open window.
  }
}

export function drain_pending(): DocRef[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    localStorage.removeItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as DocRef[]) : []
  } catch {
    return []
  }
}

export async function send_open_doc(ref: DocRef, is_tauri: boolean): Promise<void> {
  if (is_tauri) {
    try {
      const { emit } = await import(`@tauri-apps/api/event`)
      await emit(EVENT, ref)
      return
    } catch {
      // fall through to BroadcastChannel
    }
  }
  try {
    const bc = new BroadcastChannel(CHANNEL)
    bc.postMessage(ref)
    bc.close()
  } catch {
    // Web with no BroadcastChannel: the pending queue + mount drain covers it.
  }
}

export function on_open_doc(cb: (ref: DocRef) => void, is_tauri: boolean): () => void {
  if (is_tauri) {
    let un: (() => void) | null = null
    import(`@tauri-apps/api/event`).then(({ listen }) => {
      listen<DocRef>(EVENT, (e) => cb(e.payload)).then((u) => { un = u })
    })
    return () => { if (un) un() }
  }
  const bc = new BroadcastChannel(CHANNEL)
  bc.onmessage = (e) => cb(e.data as DocRef)
  return () => bc.close()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/doc-channel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer/doc-channel.ts tests/vitest/viewer/doc-channel.test.ts
git commit -m "feat(viewer): cross-window doc channel + create-race queue"
```

---

### Task 4: doc content loader

**Files:**
- Create: `src/lib/viewer/doc-content.ts`
- Test: `tests/vitest/viewer/doc-content.test.ts`

**Interfaces:**
- Consumes: `DocTab` from `doc-viewer-state.svelte`; `read_file`/`write_file` from `$lib/api/project`; `readRemoteFile`/`readRemoteBinaryFile`/`writeRemoteFile` from `$lib/api/hpc`.
- Produces:
  - `interface DocContent { text: string | null; binary: string | null; mime: string | null }`
  - `async function load_doc_content(tab: DocTab): Promise<DocContent>` — picks text vs binary by `tab.kind` (`pdf`/`image`/`excel`/`docx` → binary; others → text) and source by `origin`/`local_path`/`inline_key`.
  - `async function save_doc_content(tab: DocTab, text: string): Promise<void>` — `writeRemoteFile` (origin) or `write_file` (local_path).

- [ ] **Step 1: Write the failing test** (mock the api modules)

```ts
// tests/vitest/viewer/doc-content.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('$lib/api/project', () => ({
  read_file: vi.fn(async (p: string) => ({ path: p, name: 'a.txt', content: 'LOCAL' })),
  write_file: vi.fn(async (p: string) => ({ path: p, name: 'a.txt' })),
}))
vi.mock('$lib/api/hpc', () => ({
  readRemoteFile: vi.fn(async () => ({ success: true, content: 'REMOTE', total_lines: 1, message: '' })),
  readRemoteBinaryFile: vi.fn(async () => ({ success: true, data: 'BASE64', mime_type: 'application/pdf', size: 3 })),
  writeRemoteFile: vi.fn(async () => ({ success: true, message: '' })),
}))

import { load_doc_content } from '../../../src/lib/viewer/doc-content'
import type { DocTab } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const tab = (over: Partial<DocTab>): DocTab => ({
  id: 'd1', filename: 'a.txt', kind: 'text', editable: true,
  origin: null, local_path: '/tmp/a.txt', inline_key: null, dirty: false, ...over,
})

beforeEach(() => localStorage.clear())

describe('load_doc_content', () => {
  it('reads local text', async () => {
    expect(await load_doc_content(tab({}))).toEqual({ text: 'LOCAL', binary: null, mime: null })
  })
  it('reads remote text', async () => {
    const r = await load_doc_content(tab({ origin: { session_id: 's', file_path: '/r/a.txt' }, local_path: null }))
    expect(r.text).toBe('REMOTE')
  })
  it('reads remote binary for pdf', async () => {
    const r = await load_doc_content(tab({ kind: 'pdf', filename: 'd.pdf', origin: { session_id: 's', file_path: '/r/d.pdf' }, local_path: null }))
    expect(r).toEqual({ text: null, binary: 'BASE64', mime: 'application/pdf' })
  })
  it('reads inline text from localStorage', async () => {
    localStorage.setItem('catgo-docs-inline-x', JSON.stringify({ text: 'INLINE' }))
    const r = await load_doc_content(tab({ local_path: null, inline_key: 'catgo-docs-inline-x' }))
    expect(r.text).toBe('INLINE')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/doc-content.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/viewer/doc-content.ts
import type { DocTab } from './doc-viewer-state.svelte'

export interface DocContent {
  text: string | null
  binary: string | null
  mime: string | null
}

const BINARY_KINDS = new Set(['pdf', 'image', 'excel', 'docx'])

export async function load_doc_content(tab: DocTab): Promise<DocContent> {
  // Inline payload (path-less drops / in-memory content) handed over via localStorage.
  if (tab.inline_key) {
    try {
      const raw = localStorage.getItem(tab.inline_key)
      localStorage.removeItem(tab.inline_key)
      if (raw) {
        const parsed = JSON.parse(raw) as { text?: string; binary?: string; mime?: string }
        return { text: parsed.text ?? null, binary: parsed.binary ?? null, mime: parsed.mime ?? null }
      }
    } catch {
      // fall through to empty
    }
    return { text: null, binary: null, mime: null }
  }

  const want_binary = BINARY_KINDS.has(tab.kind)

  if (tab.origin) {
    if (want_binary) {
      const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
      const r = await readRemoteBinaryFile(tab.origin.session_id, tab.origin.file_path)
      return { text: null, binary: r.success ? r.data : null, mime: r.mime_type ?? null }
    }
    const { readRemoteFile } = await import(`$lib/api/hpc`)
    const r = await readRemoteFile(tab.origin.session_id, tab.origin.file_path)
    return { text: r.success ? r.content : null, binary: null, mime: null }
  }

  if (tab.local_path) {
    if (want_binary) {
      // Local binary read goes through the HPC binary reader with the local session.
      // For v1 local binaries are read via the project file API as base64 when available;
      // otherwise text read returns null binary (renderer shows a download affordance).
      const { read_file } = await import(`$lib/api/project`)
      const r = await read_file(tab.local_path)
      return { text: null, binary: r.content ?? null, mime: null }
    }
    const { read_file } = await import(`$lib/api/project`)
    const r = await read_file(tab.local_path)
    return { text: r.content, binary: null, mime: null }
  }

  return { text: null, binary: null, mime: null }
}

export async function save_doc_content(tab: DocTab, text: string): Promise<void> {
  if (tab.origin) {
    const { writeRemoteFile } = await import(`$lib/api/hpc`)
    await writeRemoteFile(tab.origin.session_id, tab.origin.file_path, text)
    return
  }
  if (tab.local_path) {
    const { write_file } = await import(`$lib/api/project`)
    await write_file(tab.local_path, text)
  }
}
```

> Note for implementer: local **binary** read (pdf/image/excel/docx opened from a local path) may need a dedicated base64 backend endpoint. If `read_file` does not return base64 for binaries, file a follow-up to add a `read_binary_file` project API; v1 local binaries can fall back to the inline-key path (the entry point reads bytes and stashes base64). Remote binaries already work via `readRemoteBinaryFile`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/doc-content.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer/doc-content.ts tests/vitest/viewer/doc-content.test.ts
git commit -m "feat(viewer): doc content load/save by source + kind"
```

---

### Task 5: DocxView component + mammoth dependency

**Files:**
- Modify: `package.json` (add `mammoth`)
- Create: `src/lib/viewer/DocxView.svelte`
- Test: `tests/vitest/viewer/docx-view.test.ts`

**Interfaces:**
- Produces: `DocxView.svelte` with `$props()`: `{ base64: string }` — renders sanitized HTML from a base64 .docx, read-only.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add mammoth`
Expected: `mammoth` appears under `dependencies` in `package.json`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test**

```ts
// tests/vitest/viewer/docx-view.test.ts
import { describe, it, expect } from 'vitest'
import { base64_to_arraybuffer } from '../../../src/lib/viewer/DocxView.svelte'

describe('base64_to_arraybuffer', () => {
  it('round-trips ascii bytes', () => {
    const b64 = btoa('hi')
    const buf = base64_to_arraybuffer(b64)
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([104, 105]))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/docx-view.test.ts`
Expected: FAIL — module/export not found.

- [ ] **Step 4: Write the component (export the helper for testing)**

```svelte
<!-- src/lib/viewer/DocxView.svelte -->
<script module lang="ts">
  export function base64_to_arraybuffer(b64: string): ArrayBuffer {
    const bin = atob(b64)
    const len = bin.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.buffer
  }
</script>

<script lang="ts">
  let { base64 }: { base64: string } = $props()
  let html = $state(``)
  let error = $state(``)

  $effect(() => {
    error = ``
    html = ``
    const b64 = base64
    if (!b64) return
    ;(async () => {
      try {
        const mammoth = (await import(`mammoth`)).default ?? (await import(`mammoth`))
        const result = await mammoth.convertToHtml({ arrayBuffer: base64_to_arraybuffer(b64) })
        html = result.value
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    })()
  })
</script>

{#if error}
  <div class="docx-error">{error}</div>
{:else}
  <!-- mammoth output is structural HTML from a .docx; rendered read-only -->
  <div class="docx-body">{@html html}</div>
{/if}

<style>
  .docx-body {
    padding: 16px 24px;
    overflow: auto;
    height: 100%;
    line-height: 1.5;
    color: var(--text-color, #e2e8f0);
  }
  .docx-error {
    padding: 16px;
    color: var(--error-color, #f87171);
  }
</style>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/docx-view.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/viewer/DocxView.svelte tests/vitest/viewer/docx-view.test.ts
git commit -m "feat(viewer): DocxView (mammoth docx→HTML, read-only)"
```

---

### Task 6: DocViewer window component

**Files:**
- Create: `src/lib/viewer/DocViewer.svelte`
- Test: `tests/vitest/viewer/doc-viewer.test.ts`

**Interfaces:**
- Consumes: `doc_viewer`, `open_doc`, `close_tab`, `activate`, `set_dirty` (state); `load_doc_content`, `save_doc_content` (content); `resolve_doc_kind` (kind); `drain_pending`, `on_open_doc` (channel); `FilePreviewPanel`, `MonacoEditorPanel`, `DocxView`.
- Produces: `DocViewer.svelte` — full-window. On mount: drains pending queue + subscribes to live opens. Renders a tab strip + the active tab's renderer by kind.

- [ ] **Step 1: Write the failing test** (renderer-selection helper)

```ts
// tests/vitest/viewer/doc-viewer.test.ts
import { describe, it, expect } from 'vitest'
import { renderer_for } from '../../../src/lib/viewer/DocViewer.svelte'

describe('renderer_for', () => {
  it('editable text/markdown → monaco', () => {
    expect(renderer_for('text', true)).toBe('monaco')
    expect(renderer_for('markdown', true)).toBe('monaco')
  })
  it('docx → docx', () => {
    expect(renderer_for('docx', false)).toBe('docx')
  })
  it('csv/pdf/image/excel → preview', () => {
    for (const k of ['csv', 'pdf', 'image', 'excel'] as const) {
      expect(renderer_for(k, false)).toBe('preview')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/doc-viewer.test.ts`
Expected: FAIL — export not found.

- [ ] **Step 3: Write the component**

```svelte
<!-- src/lib/viewer/DocViewer.svelte -->
<script module lang="ts">
  import type { DocKind } from './doc-kind'
  export type RendererKind = 'monaco' | 'preview' | 'docx'
  export function renderer_for(kind: DocKind, editable: boolean): RendererKind {
    if (kind === 'docx') return 'docx'
    if (editable && (kind === 'text' || kind === 'markdown')) return 'monaco'
    return 'preview'
  }
</script>

<script lang="ts">
  import { check_tauri } from '$lib/io/tauri'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { doc_viewer, open_doc, close_tab, activate, set_dirty } from './doc-viewer-state.svelte'
  import type { DocTab } from './doc-viewer-state.svelte'
  import { load_doc_content, save_doc_content } from './doc-content'
  import { resolve_doc_kind } from './doc-kind'
  import { drain_pending, on_open_doc } from './doc-channel'
  import FilePreviewPanel from '$lib/structure/FilePreviewPanel.svelte'
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import DocxView from './DocxView.svelte'

  load_i18n_module('viewer')
  const is_tauri = check_tauri()

  // Per-tab loaded content cache (id → DocContent), loaded lazily.
  let loaded = $state<Record<string, { text: string | null; binary: string | null; mime: string | null }>>({})

  $effect(() => {
    for (const ref of drain_pending()) open_doc(ref)
    const off = on_open_doc((ref) => open_doc(ref), is_tauri)
    return off
  })

  const active = $derived(doc_viewer.tabs.find((tb) => tb.id === doc_viewer.active_id) ?? null)

  // Load content for the active tab the first time it is shown.
  $effect(() => {
    const tab = active
    if (!tab || loaded[tab.id]) return
    load_doc_content(tab).then((c) => { loaded = { ...loaded, [tab.id]: c } })
  })

  function kind_for(tab: DocTab): RendererKind {
    return renderer_for(tab.kind, tab.editable)
  }
</script>

<div class="doc-viewer">
  <div class="doc-tabstrip">
    {#each doc_viewer.tabs as tab (tab.id)}
      <button
        class="doc-tab"
        class:active={tab.id === doc_viewer.active_id}
        onclick={() => activate(tab.id)}
      >
        <span class="doc-tab-name">{tab.filename}{tab.dirty ? ' •' : ''}</span>
        <span
          class="doc-tab-close"
          role="button"
          tabindex="0"
          onclick={(e) => { e.stopPropagation(); close_tab(tab.id) }}
          onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); close_tab(tab.id) } }}
        >×</span>
      </button>
    {/each}
  </div>

  <div class="doc-body">
    {#if !active}
      <div class="doc-empty">{t('viewer.empty')}</div>
    {:else if !loaded[active.id]}
      <div class="doc-empty">{t('viewer.loading')}</div>
    {:else if kind_for(active) === 'monaco'}
      {#key active.id}
        <MonacoEditorPanel
          content={loaded[active.id].text ?? ''}
          filename={active.filename}
          file_path={active.origin?.file_path ?? ''}
          session_id={active.origin?.session_id ?? ''}
          local_file_path={active.local_path ?? ''}
          readonly={!active.editable}
          onchange={() => set_dirty(active.id, true)}
          onsave={async (text) => { await save_doc_content(active, text); set_dirty(active.id, false) }}
        />
      {/key}
    {:else if kind_for(active) === 'docx'}
      {#key active.id}
        <DocxView base64={loaded[active.id].binary ?? ''} />
      {/key}
    {:else}
      {#key active.id}
        <FilePreviewPanel
          mode={resolve_doc_kind(active.filename).preview_mode ?? 'text'}
          content={loaded[active.id].text ?? ''}
          binary_data={loaded[active.id].binary ?? ''}
          mime_type={loaded[active.id].mime ?? ''}
          filename={active.filename}
          file_path={active.origin?.file_path ?? active.local_path ?? ''}
          session_id={active.origin?.session_id ?? ''}
        />
      {/key}
    {/if}
  </div>
</div>

<style>
  .doc-viewer { display: flex; flex-direction: column; height: 100vh; background: var(--bg-color, #1c1d21); }
  .doc-tabstrip { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px; border-bottom: 1px solid var(--border-color, rgba(128,128,128,0.2)); }
  .doc-tab { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 5px 5px 0 0; font-size: 12px; cursor: pointer; border: none; background: transparent; color: var(--text-muted, #94a3b8); }
  .doc-tab.active { background: var(--btn-bg, rgba(128,128,128,0.18)); color: var(--text-color, #e2e8f0); }
  .doc-tab-close { opacity: 0.6; }
  .doc-tab-close:hover { opacity: 1; }
  .doc-body { flex: 1; min-height: 0; position: relative; }
  .doc-empty { display: grid; place-items: center; height: 100%; color: var(--text-muted, #94a3b8); }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/doc-viewer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer/DocViewer.svelte tests/vitest/viewer/doc-viewer.test.ts
git commit -m "feat(viewer): DocViewer window — tab strip + per-kind renderer"
```

---

### Task 7: i18n module for the viewer

**Files:**
- Create: `src/lib/i18n/en/viewer.ts`, `src/lib/i18n/zh/viewer.ts`
- Modify: `src/lib/i18n/types.ts` (add `'viewer'` to the module union), `src/lib/i18n/index.svelte.ts:59-74` (register en+zh)
- Test: `tests/vitest/viewer/i18n-parity.test.ts`

**Interfaces:**
- Produces: i18n keys `viewer.empty`, `viewer.loading`, `viewer.title`.

- [ ] **Step 1: Write the failing parity test**

```ts
// tests/vitest/viewer/i18n-parity.test.ts
import { describe, it, expect } from 'vitest'
import en from '../../../src/lib/i18n/en/viewer'
import zh from '../../../src/lib/i18n/zh/viewer'

describe('viewer i18n parity', () => {
  it('en and zh have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
  it('has the required keys', () => {
    for (const k of ['empty', 'loading', 'title']) expect(en).toHaveProperty(k)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/i18n-parity.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create the i18n files**

```ts
// src/lib/i18n/en/viewer.ts
const viewer: Record<string, string> = {
  title: `Documents`,
  empty: `No documents open`,
  loading: `Loading…`,
}
export default viewer
```

```ts
// src/lib/i18n/zh/viewer.ts
const viewer: Record<string, string> = {
  title: `文档`,
  empty: `没有打开的文档`,
  loading: `加载中…`,
}
export default viewer
```

- [ ] **Step 4: Register the module**

In `src/lib/i18n/types.ts`, add `'viewer'` to the `TranslationModule` union (match the existing union members, e.g. `... | 'workflow' | 'viewer'`).

In `src/lib/i18n/index.svelte.ts` (the registry near lines 59-74), add to the `en` block: `viewer: () => import('./en/viewer'),` and to the `zh` block: `viewer: () => import('./zh/viewer'),` (match the surrounding entry style exactly).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/vitest/viewer/i18n-parity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/en/viewer.ts src/lib/i18n/zh/viewer.ts src/lib/i18n/types.ts src/lib/i18n/index.svelte.ts tests/vitest/viewer/i18n-parity.test.ts
git commit -m "feat(viewer): viewer i18n module (en/zh)"
```

---

### Task 8: `open_doc_window` + `#docs` route mount

**Files:**
- Modify: `desktop/lib/popout-manager.ts` (add `open_doc_window`)
- Modify: `desktop/App.svelte` (flag `popout_docs_mode`, hash branch, early-return guard, render branch)

**Interfaces:**
- Consumes: `DocRef` (`$lib/viewer/doc-viewer-state.svelte`), `enqueue_pending`/`send_open_doc` (`$lib/viewer/doc-channel`), `DocViewer` (`$lib/viewer/DocViewer.svelte`).
- Produces: `async function open_doc_window(ref: DocRef, is_tauri: boolean): Promise<void>`.

- [ ] **Step 1: Add `open_doc_window` to popout-manager.ts**

Append (mirrors `open_chat_in_new_window` + the reuse-by-label pattern):

```ts
import type { DocRef } from '$lib/viewer/doc-viewer-state.svelte'
import { enqueue_pending, send_open_doc } from '$lib/viewer/doc-channel'

/**
 * Open (or focus) the single document-viewer window and deliver a file ref.
 * Reuses the labelled `catgo-docs` window; for a fresh window the ref is queued
 * in localStorage (drained on the window's mount) to avoid the create-race.
 */
export async function open_doc_window(ref: DocRef, is_tauri: boolean) {
  const url = `${window.location.origin}${window.location.pathname}#docs`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const existing = await WebviewWindow.getByLabel(`catgo-docs`)
      if (existing) {
        await send_open_doc(ref, true)
        try { await existing.setFocus() } catch {}
        return
      }
      enqueue_pending(ref)
      const win = new WebviewWindow(`catgo-docs`, {
        title: `CatGo - Documents`,
        url, width: 1000, height: 760, center: true, resizable: true, decorations: true,
      })
      win.once(`tauri://error`, () => { window.open(url, `catgo-docs`, `width=1000,height=760,resizable=yes`) })
      return
    } catch {}
  }
  // Web: reuse the named window; queue + live post both fire.
  enqueue_pending(ref)
  const w = window.open(url, `catgo-docs`, `width=1000,height=760,resizable=yes`)
  await send_open_doc(ref, false)
  try { w?.focus() } catch {}
}
```

- [ ] **Step 2: Add the `#docs` route to App.svelte**

1. Near `popout_doping_pt_mode` (line ~164) add: `let popout_docs_mode = $state(false)`.
2. In the hash `untrack` block (after the `#doping-pt` branch, ~line 513): add
   `else if (hash.startsWith(\`#docs\`)) { popout_docs_mode = true; return }`.
3. Extend the early-return guard (line ~549) to:
   `if (popout_chat_mode || popout_status_mode || popout_doping_pt_mode || popout_docs_mode) return`.
4. Import at the top of `<script>`: `import DocViewer from '$lib/viewer/DocViewer.svelte'`.
5. In the top-level render `{#if}` chain (line ~1868), add a branch before `{:else if is_mobile}`:
   `{:else if popout_docs_mode}<DocViewer />`.
   (Also add `popout_docs_mode` alongside the other popout flags wherever they gate the keyboard/global handlers near line ~1702, matching the existing list.)

- [ ] **Step 3: Verify build + type-check**

Run: `pnpm check 2>&1 | grep -iE 'open_doc_window|DocViewer|popout_docs|svelte-check found'`
Expected: `svelte-check found 0 errors` (warnings allowed); no errors mentioning the new symbols.

- [ ] **Step 4: Commit**

```bash
git add desktop/lib/popout-manager.ts desktop/App.svelte
git commit -m "feat(viewer): open_doc_window + #docs route mount"
```

---

### Task 9: Rewire entry points to the doc viewer

**Files:**
- Modify: `desktop/lib/sidebar-handlers.ts` (`handle_sidebar_preview`, `handle_sidebar_open_editor`, `handle_terminal_open_file`)
- Modify: `desktop/App.svelte` (remove the now-dead preview/editor overlay render blocks at ~2645 and ~2656-2678; drop `editor_on_save` wiring used only by them if unused elsewhere)
- Test: `tests/vitest/viewer/entry-ref.test.ts`

**Interfaces:**
- Consumes: `resolve_doc_kind` (`$lib/viewer/doc-kind`), `open_doc_window` (`./popout-manager`), `DocRef`.
- Produces: a helper `build_doc_ref(filename, { content?, binary?, mime?, origin?, local_path? }): DocRef` in `src/lib/viewer/doc-ref.ts` that stashes inline content under a `catgo-docs-inline-<n>` key when there is no path.

- [ ] **Step 1: Write the failing test for `build_doc_ref`**

```ts
// tests/vitest/viewer/entry-ref.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { build_doc_ref } from '../../../src/lib/viewer/doc-ref'

beforeEach(() => localStorage.clear())

describe('build_doc_ref', () => {
  it('uses local_path when given, no inline key', () => {
    const ref = build_doc_ref('a.txt', { local_path: '/tmp/a.txt' })
    expect(ref).toMatchObject({ filename: 'a.txt', kind: 'text', editable: true, local_path: '/tmp/a.txt', inline_key: null })
  })
  it('uses origin for remote', () => {
    const ref = build_doc_ref('d.pdf', { origin: { session_id: 's', file_path: '/r/d.pdf' } })
    expect(ref).toMatchObject({ kind: 'pdf', editable: false, origin: { session_id: 's', file_path: '/r/d.pdf' } })
  })
  it('stashes inline content under a localStorage key when path-less', () => {
    const ref = build_doc_ref('drop.txt', { content: 'HELLO' })
    expect(ref.inline_key).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(ref.inline_key!)!)).toEqual({ text: 'HELLO', binary: null, mime: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/viewer/entry-ref.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `build_doc_ref`**

```ts
// src/lib/viewer/doc-ref.ts
import { resolve_doc_kind } from './doc-kind'
import type { DocRef } from './doc-viewer-state.svelte'

let _inline_seq = 0

export function build_doc_ref(
  filename: string,
  src: {
    content?: string
    binary?: string
    mime?: string
    origin?: { session_id: string; file_path: string }
    local_path?: string
  },
): DocRef {
  const info = resolve_doc_kind(filename, src.mime)
  let inline_key: string | null = null
  if (!src.origin && !src.local_path) {
    _inline_seq += 1
    inline_key = `catgo-docs-inline-${_inline_seq}-${filename}`
    try {
      localStorage.setItem(inline_key, JSON.stringify({
        text: src.content ?? null, binary: src.binary ?? null, mime: src.mime ?? null,
      }))
    } catch {
      // If storage fails the renderer shows an empty/error state; non-fatal.
    }
  }
  return {
    filename,
    kind: info.kind,
    editable: info.editable,
    origin: src.origin ?? null,
    local_path: src.local_path ?? null,
    inline_key,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/viewer/entry-ref.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewire `handle_sidebar_preview` and `handle_sidebar_open_editor`**

Replace their bodies (`desktop/lib/sidebar-handlers.ts:47-74`) so they build a ref and open the window instead of setting `sidebar.preview_*`/`editor_*`:

```ts
import { build_doc_ref } from '$lib/viewer/doc-ref'
import { open_doc_window } from './popout-manager'

export function handle_sidebar_preview(deps: SidebarHandlerDeps, mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) {
  const origin = session_id ? { session_id, file_path } : undefined
  const local_path = !session_id && file_path ? file_path : undefined
  const ref = build_doc_ref(filename, { content, binary: binary_data, mime: mime_type, origin, local_path })
  void open_doc_window(ref, deps.is_tauri)
}

export function handle_sidebar_open_editor(deps: SidebarHandlerDeps, content: string, filename: string, file_path: string, session_id: string) {
  const origin = session_id ? { session_id, file_path } : undefined
  const local_path = !session_id && file_path ? file_path : undefined
  const ref = build_doc_ref(filename, { content, origin, local_path })
  void open_doc_window(ref, deps.is_tauri)
}
```

(Note: `mode` param of `handle_sidebar_preview` is now unused — keep the signature for call-site compatibility but the kind is derived from `filename`.)

- [ ] **Step 6: Verify the terminal path still routes**

`handle_terminal_open_file` already calls `handle_sidebar_preview` / `handle_sidebar_open_editor` for non-structure files — no change needed; it now flows into the doc window. Confirm by reading `sidebar-handlers.ts` after the edit (no remaining `sidebar.preview_*`/`editor_*` writes for non-structure files).

- [ ] **Step 7: Remove the dead overlay render blocks in App.svelte**

Delete the MonacoEditorPanel overlay block (`desktop/App.svelte` ~2640-2650, the `{#if sidebar.editor_open}` … `onsave={sidebar.editor_on_save || undefined}` … `/>`) and the FilePreviewPanel overlay block (~2656-2678, `{#if sidebar.preview_open}` … `onclose={() => sidebar.preview_open = false}`). Leave the structure-pane text-edit path (`App.svelte:620-639`, which sets a custom `editor_on_save` to re-parse into the pane) untouched — that is NOT the sidebar overlay and must keep working via whatever it uses; if it relied on the deleted overlay, route it through the doc window too (build a ref with inline content + an `onsave` that re-parses — out of scope if it has its own panel).

> Implementer check: grep `sidebar.editor_open`, `sidebar.preview_open` after deletion. If nothing else references the `sidebar.editor_*` / `sidebar.preview_*` fields, remove them from `desktop/state/sidebar-state.svelte.ts`. If the structure-pane editor still needs them, leave those fields.

- [ ] **Step 8: Verify build, type-check, full tests**

Run: `pnpm check 2>&1 | grep -iE 'svelte-check found'`
Expected: `svelte-check found 0 errors`.
Run: `pnpm test`
Expected: all pass (existing + new viewer tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/viewer/doc-ref.ts tests/vitest/viewer/entry-ref.test.ts desktop/lib/sidebar-handlers.ts desktop/App.svelte desktop/state/sidebar-state.svelte.ts
git commit -m "feat(viewer): route non-structure file opens to the doc window"
```

---

### Task 10: Manual verification in the running app

**Files:** none (verification only)

- [ ] **Step 1: Rebuild + restart the desktop app**

Run: kill any running stack, free ports 3100/8000/8001, then `pnpm tauri:dev`.

- [ ] **Step 2: Verify each entry point opens a tab in a separate, movable window**

- Sidebar click a `.txt` → docs window opens, editable Monaco tab, edit + Ctrl+S saves.
- Sidebar click a `.md` / `.csv` / `.png` / `.pdf` / `.xlsx` → preview tab; reopening focuses the same tab (no duplicate).
- Sidebar click / drop a `.docx` → DocxView renders.
- Drag the docs window onto a second monitor; main CatGo stays on the primary screen.
- Terminal Ctrl+click a non-structure file → opens a tab.
- Open 3 files → 3 tabs; close middle → neighbor activates.

- [ ] **Step 3: Confirm no regressions**

- Structure / trajectory files still load into the main-window 3D pane (NOT the doc window).
- Old full-screen editor/preview overlay no longer appears.

---

## Self-Review

**Spec coverage:** OS window (Task 8) ✓; multi-tab + dedupe (Task 2) ✓; v1 kinds incl. docx (Tasks 1, 5, 6) ✓; editable+Save (Task 6, 9) ✓; all four entry points (Task 9 + terminal note) ✓; lightweight ref + self-resolve content + inline localStorage (Tasks 3, 4, 9) ✓; pluggable renderers (Task 6 `renderer_for` map) ✓; pptx deferred (not built) ✓; error handling (Task 4 note, DocxView error, empty/loading states) ✓; i18n parity (Task 7) ✓.

**Placeholder scan:** no TBD/TODO; the two implementer notes (local-binary endpoint in Task 4, structure-pane editor in Task 9 Step 7) are explicit conditional instructions, not placeholders.

**Type consistency:** `DocRef`/`DocTab` fields (`origin`/`local_path`/`inline_key`/`kind`/`editable`) consistent across Tasks 2,3,4,8,9; `resolve_doc_kind` return shape consistent (Tasks 1,6,9); `renderer_for` kinds match `DocKind` (Tasks 1,6).

**Known follow-ups (not blocking v1):** local binary (pdf/image/excel/docx from a local path) may need a base64 project endpoint — Task 4 falls back to the inline-key path meanwhile; pptx renderer; persist open tabs across restarts.
