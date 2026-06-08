<script lang="ts">
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    show = $bindable(),
    view,
    loading,
    filename,
    work_dir,
    files,
    content,
    file_path,
    session_id,
    onopen_file,
    onback_to_list,
    onclose,
    onsave,
  }: {
    show: boolean
    view: `list` | `editor`
    loading: boolean
    filename: string
    work_dir: string
    files: Array<{ name: string; size: string; modified: string }>
    content: string
    file_path: string
    session_id: string
    onopen_file: (filename: string) => void
    onback_to_list: () => void
    onclose: () => void
    /** When provided, the file is editable and Ctrl+S / Save writes it back. Omit for read-only. */
    onsave?: (content: string) => void | Promise<void>
  } = $props()
</script>

{#if show}
  <div class="vasp-modal-overlay" onclick={onclose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="vasp-modal" onclick={(e) => e.stopPropagation()}>
      <div class="vasp-modal-header">
        <h3 class="vasp-modal-title">
          {view === 'editor' ? filename : t('workflow.file_browser_step_files')}
        </h3>
        {#if view === 'editor'}
          <button class="vasp-tab" onclick={onback_to_list}>
            {t('workflow.file_browser_back_to_files')}
          </button>
        {/if}
        <div style="flex:1"></div>
        <div class="vasp-modal-actions">
          <button class="vasp-close-btn" onclick={onclose}>&times;</button>
        </div>
      </div>
      <div class="vasp-modal-body">
        {#if loading}
          <div class="vasp-loading">{t('common.loading')}</div>
        {:else if view === 'list'}
          <div class="file-list-panel">
            {#if work_dir}
              <div class="file-work-dir">{work_dir}</div>
            {/if}
            {#if files.length === 0}
              <div class="file-empty">{t('workflow.file_browser_no_workdir_files')}</div>
            {:else}
              <div class="file-list">
                {#each files as file}
                  <button class="file-item" onclick={() => onopen_file(file.name)}>
                    <span class="file-name">{file.name}</span>
                    <span class="file-size">{file.size}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <MonacoEditorPanel
            {content}
            {filename}
            file_path={onsave ? `` : file_path}
            session_id={onsave ? `` : session_id}
            readonly={!onsave}
            {onsave}
            onclose={onback_to_list}
          />
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vasp-modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
  }
  .vasp-modal {
    width: min(900px, 90vw); height: min(700px, 85vh);
    background: var(--surface-bg); border: 1px solid var(--border-color); border-radius: 10px;
    display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .vasp-modal-header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08)); flex-shrink: 0;
  }
  .vasp-modal-title { font-size: 14px; font-weight: 700; color: var(--text-color, #eee); margin: 0; white-space: nowrap; }
  .vasp-tab {
    padding: 6px 16px; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-color-muted); font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .vasp-tab:hover { color: var(--text-color-muted, #94a3b8); }
  .vasp-modal-actions { display: flex; gap: 6px; }
  .vasp-close-btn {
    padding: 3px 8px; background: none; border: 1px solid var(--border-color);
    border-radius: 5px; color: var(--text-color-muted, #94a3b8); font-size: 16px; cursor: pointer; line-height: 1;
  }
  .vasp-close-btn:hover { background: var(--surface-bg-hover); color: var(--text-color, #eee); }
  .vasp-modal-body { flex: 1; overflow: hidden; display: flex; }
  .vasp-modal-body > :global(*) { width: 100%; }
  .vasp-loading {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; font-size: 13px; color: var(--text-color-muted);
  }
  .file-list-panel { width: 100%; padding: 12px 16px; overflow-y: auto; }
  .file-work-dir {
    font-size: 11px; color: var(--text-color-muted); padding: 6px 10px; margin-bottom: 10px;
    background: var(--surface-bg); border-radius: 4px; font-family: monospace;
    word-break: break-all;
  }
  .file-empty { text-align: center; color: var(--text-color-muted); font-size: 13px; padding: 24px; }
  .file-list { display: flex; flex-direction: column; gap: 2px; }
  .file-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02));
    border: 1px solid light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.04)); border-radius: 5px;
    color: var(--text-color); font-size: 13px; cursor: pointer; text-align: left;
  }
  .file-item:hover { background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.06)); border-color: light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.1)); }
  .file-name { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .file-size { font-size: 11px; color: var(--text-color-muted); }
</style>
