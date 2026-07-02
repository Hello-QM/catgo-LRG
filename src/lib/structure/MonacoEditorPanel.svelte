<script lang="ts">
  import { writeRemoteFile } from '$lib/api/hpc'

  let {
    content = ``,
    filename = ``,
    file_path = ``,
    session_id = ``,
    /** Local filesystem path for saving back (desktop mode). */
    local_file_path = ``,
    readonly = false,
    onclose,
    onsave,
    onchange,
    onvisualize,
    edit_action = null,
  }: {
    content?: string
    filename?: string
    /** Full remote path for saving back. */
    file_path?: string
    /** HPC session_id for remote save. */
    session_id?: string
    /** Local filesystem path — saves via Vite middleware write. */
    local_file_path?: string
    readonly?: boolean
    onclose?: () => void
    onsave?: (content: string) => void
    /** Fires on every content change so the parent can track live editor text. */
    onchange?: (content: string) => void
    /** Callback to visualize the file content as structure/trajectory. */
    onvisualize?: (content: string, filename: string) => void
    /** Optional extra header button (e.g. the doc viewer's Render toggle),
     *  rendered with the same styling as Visualize/Save. */
    edit_action?: { label: string; onclick: () => void } | null
  } = $props()

  let container_el: HTMLDivElement | undefined = $state()
  let editor_instance: any = null
  let is_dirty = $state(false)
  let save_status = $state<`idle` | `saving` | `saved` | `error`>(`idle`)
  let save_error = $state(``)

  /** Whether the current file can be visualized as structure or trajectory. */
  let can_visualize = $state(false)
  $effect(() => {
    if (!onvisualize || !filename) { can_visualize = false; return }
    Promise.all([
      import(`$lib/structure/parse`),
      import(`$lib/trajectory/parse`),
    ]).then(([s, t]) => {
      can_visualize = s.is_structure_file(filename) || t.is_trajectory_file(filename)
    })
  })

  function do_visualize() {
    if (!onvisualize || !editor_instance) return
    onvisualize(editor_instance.getValue(), filename)
  }

  // Infer language from filename
  function get_language(name: string): string {
    const ext = name.split(`.`).pop()?.toLowerCase() || ``
    const map: Record<string, string> = {
      py: `python`, sh: `shell`, bash: `shell`, zsh: `shell`,
      json: `json`, yaml: `yaml`, yml: `yaml`, toml: `toml`,
      js: `javascript`, ts: `typescript`, html: `html`, css: `css`,
      md: `markdown`, xml: `xml`, sql: `sql`, r: `r`,
      c: `c`, cpp: `cpp`, h: `c`, hpp: `cpp`,
      f90: `fortran`, f: `fortran`, f77: `fortran`,
      rs: `rust`, go: `go`, java: `java`,
      txt: `plaintext`, log: `plaintext`, out: `plaintext`,
      cif: `plaintext`, poscar: `plaintext`, vasp: `plaintext`,
      contcar: `plaintext`, incar: `plaintext`, kpoints: `plaintext`,
      potcar: `plaintext`, inp: `plaintext`, pwi: `plaintext`,
    }
    // Handle VASP files without extension
    const base = name.toUpperCase()
    if ([`INCAR`, `POSCAR`, `CONTCAR`, `KPOINTS`, `POTCAR`, `OUTCAR`].includes(base)) {
      return `plaintext`
    }
    return map[ext] || `plaintext`
  }

  let is_programmatic_change = false

  $effect(() => {
    if (!container_el) return
    let disposed = false
    let editor: any = null

    async function init() {
      // Monaco cancels in-flight async work (delayers, worker requests) when an
      // editor/model is disposed — on close or an HMR/reload remount — surfacing
      // as a benign `Unhandled rejection: Canceled`. Unlike the worker-thrown
      // inlay-hints error, this one rejects on the MAIN thread, so a scoped
      // handler can swallow it. Drop ONLY `Canceled` (by name/message), once,
      // globally; every other rejection propagates untouched.
      const g = self as unknown as { __catgo_monaco_canceled_guard?: boolean }
      if (!g.__catgo_monaco_canceled_guard) {
        g.__catgo_monaco_canceled_guard = true
        self.addEventListener(`unhandledrejection`, (e: PromiseRejectionEvent) => {
          const r = e.reason as { name?: string; message?: string } | undefined
          if (r && (r.name === `Canceled` || r.message === `Canceled`)) e.preventDefault()
        })
      }

      // Dynamic import for SSR safety
      const monaco = await import(`monaco-editor`)

      if (disposed) return

      // Configure Monaco environment for web workers
      // @ts-ignore
      self.MonacoEnvironment = {
        getWorker(_: string, label: string) {
          // Each language needs its OWN worker — the base editor.worker lacks
          // language-service methods, so opening e.g. a .ts file with only the
          // base worker floods the console with
          // `Missing requestHandler or method: provideInlayHints`. Route every
          // language Monaco bundles a worker for to that worker.
          if (label === `json`) {
            return new Worker(
              new URL(`monaco-editor/esm/vs/language/json/json.worker.js`, import.meta.url),
              { type: `module` },
            )
          }
          if (label === `css` || label === `scss` || label === `less`) {
            return new Worker(
              new URL(`monaco-editor/esm/vs/language/css/css.worker.js`, import.meta.url),
              { type: `module` },
            )
          }
          if (label === `html` || label === `handlebars` || label === `razor`) {
            return new Worker(
              new URL(`monaco-editor/esm/vs/language/html/html.worker.js`, import.meta.url),
              { type: `module` },
            )
          }
          if (label === `typescript` || label === `javascript`) {
            return new Worker(
              new URL(`monaco-editor/esm/vs/language/typescript/ts.worker.js`, import.meta.url),
              { type: `module` },
            )
          }
          return new Worker(
            new URL(`monaco-editor/esm/vs/editor/editor.worker.js`, import.meta.url),
            { type: `module` },
          )
        },
      }

      // The TS/JS language service registers worker-backed providers (inlay
      // hints, completions, diagnostics, …). One of them — inlay hints — routes
      // its request through the base editor worker's foreign-module
      // (`EditorWorker.$fmr`), which can't handle `provideInlayHints` in monaco
      // 0.55, so every .ts/.js open floods the console. This is a file
      // viewer/editor, not an IDE, so it needs NONE of those language services —
      // only main-thread syntax highlighting (Monarch), which is unaffected.
      // Disable the whole worker-backed feature set so no `$fmr` request is ever
      // issued. (The editor's `inlayHints.enabled` option is a separate,
      // insufficient lever — the provider still registers.)
      const ts_langs = (monaco.languages as { typescript?: {
        typescriptDefaults?: { setModeConfiguration: (c: Record<string, boolean>) => void }
        javascriptDefaults?: { setModeConfiguration: (c: Record<string, boolean>) => void }
      } }).typescript
      const NO_LANG_FEATURES: Record<string, boolean> = {
        completionItems: false, hovers: false, documentSymbols: false,
        definitions: false, references: false, documentHighlights: false,
        rename: false, diagnostics: false, documentRangeFormattingEdits: false,
        signatureHelp: false, onTypeFormattingEdits: false, codeActions: false,
        inlayHints: false,
      }
      for (const d of [ts_langs?.typescriptDefaults, ts_langs?.javascriptDefaults]) {
        try {
          d?.setModeConfiguration(NO_LANG_FEATURES)
        } catch { /* older monaco without modeConfiguration — editor option covers it */ }
      }

      editor = monaco.editor.create(container_el!, {
        value: content,
        language: get_language(filename),
        theme: `vs-dark`,
        automaticLayout: true,
        fontSize: 13,
        fontFamily: `'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace`,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: `on`,
        readOnly: readonly,
        tabSize: 2,
        renderWhitespace: `selection`,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        lineNumbers: `on`,
        folding: true,
        smoothScrolling: true,
        cursorBlinking: `smooth`,
        cursorSmoothCaretAnimation: `on`,
        stickyScroll: { enabled: false },
        // Inlay hints route through the base editor worker's foreign-module
        // (`EditorWorker.$fmr`), which doesn't implement `provideInlayHints` in
        // monaco 0.55 → every TS/JS open flooded the console with
        // `Missing requestHandler or method: provideInlayHints`. This is a file
        // viewer/editor, not an IDE, so inlay hints add nothing — turn them off.
        inlayHints: { enabled: `off` },
      })
      editor_instance = editor

      // Track dirty state and notify parent of live content changes
      editor.onDidChangeModelContent(() => {
        if (!is_programmatic_change) {
          is_dirty = true
          save_status = `idle`
          onchange?.(editor.getValue())
        }
      })

      // Ctrl+S / Cmd+S to save
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => do_save(),
      )

      editor.focus()
      // Force layout recalc after flex containers settle — fixes scrollbar
      // not working when panel first appears
      requestAnimationFrame(() => editor?.layout())
      setTimeout(() => editor?.layout(), 100)
    }

    init()

    return () => {
      disposed = true
      editor?.dispose()
      editor_instance = null
    }
  })

  // Update editor content when prop changes (but not from user edits)
  $effect(() => {
    if (editor_instance && content !== undefined && content !== editor_instance.getValue()) {
      is_programmatic_change = true
      editor_instance.setValue(content)
      is_programmatic_change = false
      is_dirty = false
    }
  })

  async function do_save() {
    if (!editor_instance || readonly) return
    const value = editor_instance.getValue()
    save_status = `saving`
    save_error = ``

    try {
      if (onsave) {
        // When a parent provides onsave, it is the authoritative writer (e.g.
        // workflow file editors persist via the V2 engine endpoint, which handles
        // both local and HPC-remote work_dirs). Awaited so a failure surfaces as
        // an error state instead of a false "saved". Takes priority over the
        // remote/local branches below — no current caller passes onsave AND
        // relies on writeRemoteFile/write_file.
        await onsave(value)
        save_status = `saved`
        is_dirty = false
      } else if (session_id && file_path) {
        // Save to remote server
        const result = await writeRemoteFile(session_id, file_path, value)
        if (result.success) {
          save_status = `saved`
          is_dirty = false
        } else {
          save_status = `error`
          save_error = result.message || `Save failed`
        }
      } else if (local_file_path) {
        // Save to local filesystem via Vite middleware
        const { write_file } = await import(`$lib/api/project`)
        await write_file(local_file_path, value)
        save_status = `saved`
        is_dirty = false
      } else {
        // No file target — just notify parent (onsave is falsy in all else branches)
        save_status = `saved`
        is_dirty = false
      }
    } catch (e: any) {
      save_status = `error`
      save_error = e?.message || String(e)
    }
  }
</script>

<div class="editor-panel">
  <div class="editor-header">
    <div class="editor-title" title={filename || `Untitled`}>
      {filename || `Untitled`}{#if is_dirty} <span class="dirty-dot" title="Unsaved changes"></span>{/if}
    </div>
    <div class="editor-status">
      {#if save_status === `saving`}
        <span class="status-text saving">Saving...</span>
      {:else if save_status === `saved`}
        <span class="status-text saved">Saved</span>
      {:else if save_status === `error`}
        <span class="status-text error" title={save_error}>Error</span>
      {/if}
    </div>
    <div class="editor-controls">
      {#if edit_action}
        <button class="editor-btn action-btn" onclick={edit_action.onclick}>
          {edit_action.label}
        </button>
      {/if}
      {#if can_visualize}
        <button
          class="editor-btn visualize-btn"
          onclick={do_visualize}
          title="Visualize as structure"
        >
          &#9654; Visualize
        </button>
      {/if}
      {#if !readonly}
        <button
          class="editor-btn save-btn"
          onclick={do_save}
          disabled={!is_dirty || save_status === `saving`}
          title="Save (Ctrl+S)"
        >
          Save
        </button>
      {/if}
      {#if onclose}
        <button class="editor-btn close-btn" onclick={onclose} title="Close editor">
          &times;
        </button>
      {/if}
    </div>
  </div>
  <div class="editor-container" bind:this={container_el}></div>
</div>

<style>
  .editor-panel {
    display: flex;
    flex-direction: column;
    border-left: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    min-height: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .editor-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.3));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }
  .editor-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--struct-text-color, #ccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirty-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: light-dark(#d97706, #ffd43b);
    vertical-align: middle;
  }
  .editor-status {
    font-size: 0.72em;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .status-text.saving { color: var(--warning-color, light-dark(#d97706, #ffd43b)); }
  .status-text.saved { color: var(--success-color); }
  .status-text.error { color: var(--error-color); }
  .editor-controls {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .editor-btn {
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.12));
    color: var(--struct-text-color, #aaa);
    border-radius: 3px;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 0.75em;
    line-height: 1.4;
  }
  .editor-btn:hover:not(:disabled) {
    background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.15));
    color: var(--text-color);
  }
  .editor-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .visualize-btn,
  .action-btn {
    color: var(--accent-color, #4dabf7);
    border-color: color-mix(in srgb, var(--accent-color, #4dabf7) 30%, transparent);
  }
  .save-btn {
    color: var(--success-color);
    border-color: color-mix(in srgb, var(--success-color) 30%, transparent);
  }
  .close-btn {
    font-size: 1em !important;
    padding: 0 5px !important;
  }
  .editor-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
