<!-- src/lib/viewer/DocViewer.svelte -->
<script module lang="ts">
  import type { DocKind } from './doc-kind'
  export type RendererKind = 'monaco' | 'preview' | 'docx' | 'mdpreview' | 'htmlview'
  export function renderer_for(kind: DocKind, view: 'preview' | 'edit'): RendererKind {
    if (kind === 'docx') return 'docx'
    if (kind === 'csv' || kind === 'pdf' || kind === 'image' || kind === 'excel') return 'preview'
    if (kind === 'markdown') return view === 'edit' ? 'monaco' : 'mdpreview'
    if (kind === 'html') return view === 'edit' ? 'monaco' : 'htmlview'
    return 'monaco' // plain text/code
  }
</script>

<script lang="ts">
  import { check_tauri } from '$lib/io/tauri'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { doc_viewer, open_doc, close_tab, activate, set_dirty, set_view } from './doc-viewer-state.svelte'
  import type { DocTab } from './doc-viewer-state.svelte'
  import { load_doc_content, save_doc_content } from './doc-content'
  import { resolve_doc_kind } from './doc-kind'
  import { on_open_doc, emit_docs_ready } from './doc-channel'
  import FilePreviewPanel from '$lib/structure/FilePreviewPanel.svelte'
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import DocxView from './DocxView.svelte'
  import HtmlView from './HtmlView.svelte'

  load_i18n_module('viewer')
  const is_tauri = check_tauri()

  // Per-tab loaded content cache (id → DocContent), loaded lazily.
  let loaded = $state<Record<string, { text: string | null; binary: string | null; mime: string | null }>>({})

  $effect(() => {
    // Subscribe first so no event is missed between listen setup and ready signal.
    const off = on_open_doc((ref) => open_doc(ref), is_tauri)
    // Signal to the opener that we are ready to receive the queued ref.
    void emit_docs_ready(is_tauri)
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
    return renderer_for(tab.kind, tab.view)
  }

  function toggle_view(tab: DocTab): void {
    set_view(tab.id, tab.view === 'edit' ? 'preview' : 'edit')
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
    {:else}
      {#if active.kind === 'markdown' || active.kind === 'html'}
        <div class="doc-view-toggle">
          <button
            class="view-toggle-btn"
            class:active={active.view === 'preview'}
            onclick={() => toggle_view(active)}
          >
            {active.view === 'edit' ? t('viewer.render') : t('viewer.edit')}
          </button>
        </div>
      {/if}
      {#if kind_for(active) === 'monaco'}
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
      {:else if kind_for(active) === 'mdpreview'}
        {#key active.id}
          <FilePreviewPanel
            mode="markdown"
            content={loaded[active.id].text ?? ''}
            filename={active.filename}
            file_path={active.origin?.file_path ?? active.local_path ?? ''}
            session_id={active.origin?.session_id ?? ''}
          />
        {/key}
      {:else if kind_for(active) === 'htmlview'}
        {#key active.id}
          <HtmlView html={loaded[active.id].text ?? ''} />
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
  .doc-view-toggle { position: absolute; top: 6px; right: 10px; z-index: 10; }
  .view-toggle-btn { padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: 1px solid var(--border-color, rgba(128,128,128,0.3)); background: var(--btn-bg, rgba(128,128,128,0.12)); color: var(--text-muted, #94a3b8); }
  .view-toggle-btn:hover { color: var(--text-color, #e2e8f0); }
</style>
