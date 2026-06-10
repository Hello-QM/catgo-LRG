<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { BrowseResult } from '$lib/api/project'

  load_i18n_module('common')

  let {
    visible = $bindable(false),
    mode = 'open',
    dir = $bindable(''),
    filename = $bindable(''),
    items = [],
    loading = false,
    parent = '',
    onbrowse,
    onconfirm,
  }: {
    visible: boolean
    mode: 'open' | 'new' | 'save-as'
    dir: string
    filename: string
    items: BrowseResult['items']
    loading: boolean
    parent: string
    onbrowse: (dir: string) => void
    onconfirm: (selected_path?: string) => void
  } = $props()
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fp-overlay" onclick={() => visible = false}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fp-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="fp-header">
        <span class="fp-title">
          {mode === `open` ? t('sidebar.open_database') : mode === `new` ? t('sidebar.new_database') : t('sidebar.save_database_as')}
        </span>
        <button class="fp-close" onclick={() => visible = false}>&times;</button>
      </div>

      <!-- Path bar -->
      <div class="fp-pathbar">
        <button class="fp-up-btn" onclick={() => onbrowse(parent)} disabled={dir === `__drives__`} title={t('sidebar.go_up')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span class="fp-path" title={dir}>{dir === `__drives__` ? t('app.this_pc') : dir}</span>
      </div>

      <!-- File list -->
      <div class="fp-list">
        {#if loading}
          <div class="fp-loading">{t('common.loading')}</div>
        {:else if items.length === 0}
          <div class="fp-empty">{t('app.no_folders_or_db')}</div>
        {:else}
          {#each items as item (item.path)}
            {#if item.type === `dir`}
              <button class="fp-item fp-dir"
                onclick={dir === `__drives__` ? () => onbrowse(item.path) : undefined}
                ondblclick={dir !== `__drives__` ? () => onbrowse(item.path) : undefined}>
                {#if dir === `__drives__`}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M6 12h.01M6 16h.01"/></svg>
                {:else}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
                {/if}
                {item.name}
              </button>
            {:else}
              <button class="fp-item fp-file" class:fp-selected={filename === item.name}
                onclick={() => filename = item.name}
                ondblclick={() => onconfirm(item.path)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
                {item.name}
              </button>
            {/if}
          {/each}
        {/if}
      </div>

      <!-- Filename input (for new / save-as) -->
      {#if mode !== `open`}
        <div class="fp-filename-row">
          <span class="fp-filename-label">{t('common.name')}:</span>
          <input class="fp-filename-input" bind:value={filename} placeholder={t('common.database_filename_placeholder')}
            onkeydown={(e) => { if (e.key === `Enter`) onconfirm() }} />
        </div>
      {/if}

      <!-- Actions -->
      <div class="fp-actions">
        <button class="fp-btn fp-btn-cancel" onclick={() => visible = false}>{t('common.cancel')}</button>
        {#if mode === `open`}
          <button class="fp-btn fp-btn-ok" disabled={!filename}
            onclick={() => {
              const found = items.find(i => i.name === filename)
              if (found) onconfirm(found.path)
            }}>{t('common.open')}</button>
        {:else}
          <button class="fp-btn fp-btn-ok" disabled={!filename}
            onclick={() => onconfirm()}>
            {mode === `new` ? t('common.create') : t('common.save')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* [2025-02] In-app file picker modal */
  .fp-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 1000;
    overflow: auto;
  }

  .fp-dialog {
    background: var(--page-bg, #1a1f2e);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
    border-radius: 8px;
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .fp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .fp-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, #e2e8f0);
  }

  .fp-close {
    background: none;
    border: none;
    color: var(--text-color-muted, #6b7280);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .fp-close:hover { color: var(--text-color, #e2e8f0); }

  .fp-pathbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.1));
    background: rgba(128, 128, 128, 0.04);
  }

  .fp-up-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    flex-shrink: 0;
  }

  .fp-up-btn:hover {
    color: var(--text-color, #e2e8f0);
    background: rgba(128, 128, 128, 0.15);
  }

  .fp-path {
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .fp-list {
    flex: 1;
    overflow-y: auto;
    min-height: 200px;
    max-height: 350px;
    padding: 4px 0;
  }

  .fp-loading, .fp-empty {
    padding: 20px;
    text-align: center;
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
  }

  .fp-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 5px 14px;
    font-size: 12px;
    background: transparent;
    border: none;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fp-item svg {
    flex-shrink: 0;
  }

  .fp-item:hover { background: rgba(128, 128, 128, 0.1); }
  .fp-dir { color: #60a5fa; }
  .fp-file { color: var(--text-color, #e2e8f0); }
  .fp-selected { background: rgba(59, 130, 246, 0.15) !important; }

  .fp-filename-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.1));
  }

  .fp-filename-label {
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    flex-shrink: 0;
  }

  .fp-filename-input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #e2e8f0);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    outline: none;
  }

  .fp-filename-input:focus {
    border-color: rgba(59, 130, 246, 0.5);
  }

  .fp-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  }

  .fp-btn {
    padding: 5px 16px;
    font-size: 12px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
  }

  .fp-btn-cancel {
    background: rgba(128, 128, 128, 0.15);
    color: var(--text-color-muted, #94a3b8);
  }

  .fp-btn-cancel:hover { background: rgba(128, 128, 128, 0.25); }

  .fp-btn-ok {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .fp-btn-ok:hover:not(:disabled) { background: rgba(59, 130, 246, 0.35); }
  .fp-btn-ok:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
