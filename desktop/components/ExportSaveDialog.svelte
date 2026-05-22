<script lang="ts">
  import type { ProjectSummary } from '$lib/api/project'
  import { t } from '$lib/i18n/index.svelte'
  import { exp } from '../state/export-state.svelte'
  import { update_export_format } from '../pane-utils'

  interface Props {
    save_project_roots: ProjectSummary[]
    save_project_children: Record<string, ProjectSummary[]>
    hpc_path: string
    export_fs_browse: (dir: string) => void
    do_export: () => void
  }

  let { save_project_roots, save_project_children, hpc_path, export_fs_browse, do_export }: Props = $props()
</script>

{#if exp.dialog}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={() => { exp.dialog = null; exp.close_after = null }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
      <h3>{exp.dialog.mode === `project` ? t('app.save_to_db') : t('app.export_to_local', { target: exp.dialog.mode === `hpc` ? t('app.export_to_hpc') : t('app.export_to_local') }).replace('Export to ', '').replace('导出至', '')}</h3>
      <div class="export-form">
        {#if exp.dialog.mode === `project`}
          <!-- Project folder picker -->
          <span class="export-label-text">{t('common.folder')} <span class="export-hint">({t('common.optional')})</span>:</span>
          <div class="save-project-tree">
            {#if exp.close_save_projects.length > 0}
              <button
                class="save-tree-item"
                class:selected={!exp.close_save_project_id}
                style:padding-left="8px"
                onclick={() => exp.close_save_project_id = null}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" /><path d="M8 12h8" />
                </svg>
                {t('app.root_folder')}
              </button>
              {#snippet save_tree_node(projects: ProjectSummary[], depth: number)}
                {#each projects as p (p.id)}
                  <button
                    class="save-tree-item"
                    class:selected={exp.close_save_project_id === p.id}
                    style:padding-left="{8 + (depth + 1) * 16}px"
                    onclick={() => exp.close_save_project_id = p.id}
                    ondblclick={do_export}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    {p.name}
                  </button>
                  {#if save_project_children[p.id]?.length}
                    {@render save_tree_node(save_project_children[p.id], depth + 1)}
                  {/if}
                {/each}
              {/snippet}
              {@render save_tree_node(save_project_roots, 0)}
            {:else}
              <span class="export-fs-hint">{t('app.no_folders_saved_to_root')}</span>
            {/if}
          </div>
        {:else if exp.dialog.mode === `hpc`}
          <!-- HPC destination -->
          <label class="export-label">
            <span>{t('common.destination')}:</span>
            <span class="export-path">{hpc_path || `~`}</span>
          </label>
        {:else}
          <!-- Filesystem directory picker -->
          <span class="export-label-text">{t('common.directory')}:</span>
          <div class="export-fs-browser">
            <div class="export-fs-pathbar">
              <button class="export-fs-up" onclick={() => {
                const parent = exp.fs_dir.replace(/[/\\][^/\\]*$/, ``) || `/`
                export_fs_browse(parent)
              }} disabled={exp.fs_loading || exp.fs_dir === `/`} title={t('app.parent_directory')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <input class="export-fs-path-input" type="text" value={exp.fs_dir} onkeydown={(e) => {
                if (e.key === `Enter`) export_fs_browse((e.target as HTMLInputElement).value)
              }} />
              <button class="export-fs-up" onclick={() => export_fs_browse(`~`)} title={t('app.home_directory')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3m10-11v10a1 1 0 01-1 1h-3"/></svg>
              </button>
            </div>
            <div class="export-fs-list">
              {#if exp.fs_loading}
                <span class="export-fs-hint">{t('common.loading')}</span>
              {:else if exp.fs_items.length === 0}
                <span class="export-fs-hint">{t('app.no_subdirectories')}</span>
              {:else}
                {#each exp.fs_items as item (item.path)}
                  <button class="export-fs-item" ondblclick={() => export_fs_browse(item.path)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    {item.name}
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
        <label class="export-label">
          <span>{t('common.filename')}</span>
          <input
            type="text"
            class="export-input"
            bind:value={exp.dialog.filename}
            oninput={() => { if (exp.dialog) exp.dialog.format = update_export_format(exp.dialog.filename) }}
            onkeydown={(e) => { if (e.key === `Enter`) do_export() }}
          />
        </label>
        <label class="export-label">
          <span>{t('common.format')}</span>
          <select class="export-select" bind:value={exp.dialog.format} onchange={() => {
            if (!exp.dialog) return
            const ext_map: Record<string, string> = { poscar: `.poscar`, xyz: `.xyz`, extxyz: `.extxyz`, cif: `.cif` }
            const ext = ext_map[exp.dialog.format] || `.cif`
            const base = exp.dialog.filename.replace(/\.[^.]+$/, ``)
            exp.dialog.filename = `${base}${ext}`
          }}>
            <option value="cif">CIF</option>
            <option value="poscar">POSCAR</option>
            <option value="extxyz">{t('app.extxyz_desc')}</option>
            <option value="xyz">{t('app.xyz_desc')}</option>
          </select>
        </label>
        {#if exp.error}
          <p class="export-error">{exp.error}</p>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="modal-btn cancel" onclick={() => { exp.dialog = null; exp.close_after = null }}>{t('common.cancel')}</button>
        <button class="modal-btn confirm" disabled={exp.saving || !exp.dialog.filename || (exp.dialog.mode === `file` && !exp.fs_dir)} onclick={do_export}>
          {exp.saving ? t('common.saving') : exp.dialog.mode === `project` ? t('common.save') : t('common.export')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100000050;
    animation: fade-in 0.15s ease-out;
  }

  .modal-dialog {
    background: var(--dialog-bg, var(--surface-bg, #1c1c2e));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 12px;
    padding: 24px;
    min-width: 320px;
    max-width: 420px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  }

  .modal-dialog h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, #374151);
    margin: 0 0 8px 0;
  }

  .modal-dialog p {
    font-size: 13px;
    color: var(--text-color-muted, #6b7280);
    margin: 0 0 20px 0;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-btn {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  }

  .modal-btn.cancel {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
    color: var(--text-color, #374151);
  }

  .modal-btn.cancel:hover {
    background: var(--btn-bg-hover, rgba(128, 128, 128, 0.2));
  }

  .modal-btn.confirm {
    background: rgba(34, 197, 94, 0.8);
    border-color: rgba(34, 197, 94, 0.5);
    color: white;
  }

  .modal-btn.confirm:hover:not(:disabled) {
    background: rgba(34, 197, 94, 1);
  }

  .modal-btn.confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .save-project-tree {
    max-height: 240px;
    overflow-y: auto;
    margin: 8px 0;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    scrollbar-width: thin;
  }

  .save-tree-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
    background: transparent;
    border: none;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .save-tree-item:hover {
    background: rgba(59, 130, 246, 0.1);
  }

  .save-tree-item.selected {
    background: rgba(59, 130, 246, 0.2);
    outline: 1px solid rgba(59, 130, 246, 0.4);
    outline-offset: -1px;
  }

  .save-tree-item svg {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .save-tree-item.selected svg {
    opacity: 0.9;
  }

  .export-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 16px;
  }

  .export-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-color-muted, #6b7280);
  }

  .export-label-text {
    font-size: 12px;
    color: var(--text-color-muted, #6b7280);
    margin-bottom: 2px;
  }

  .export-hint {
    opacity: 0.6;
    font-weight: normal;
  }

  .export-path {
    font-size: 12px;
    color: var(--text-color, #374151);
    background: var(--code-bg, rgba(128, 128, 128, 0.1));
    padding: 4px 8px;
    border-radius: 4px;
    word-break: break-all;
    font-family: monospace;
  }

  .export-fs-browser {
    margin: 4px 0;
  }

  .export-fs-pathbar {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
  }

  .export-fs-path-input {
    flex: 1;
    padding: 4px 8px;
    font-size: 12px;
    font-family: monospace;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    color: var(--text-color, #e2e8f0);
    outline: none;
  }

  .export-fs-path-input:focus {
    border-color: var(--accent, #6366f1);
  }

  .export-fs-up {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    padding: 0;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
  }

  .export-fs-up:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.1);
  }

  .export-fs-up:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .export-fs-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 4px;
    scrollbar-width: thin;
  }

  .export-fs-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    font-size: 12px;
    background: transparent;
    border: none;
    color: var(--text-color, #e2e8f0);
    cursor: pointer;
    text-align: left;
  }

  .export-fs-item:hover {
    background: rgba(59, 130, 246, 0.1);
  }

  .export-fs-item svg {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .export-fs-hint {
    display: block;
    padding: 8px;
    font-size: 11px;
    color: var(--text-color-muted, #6b7280);
    text-align: center;
  }

  .export-input, .export-select {
    padding: 6px 8px;
    font-size: 13px;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 6px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    color: var(--text-color, #374151);
    outline: none;
  }

  .export-input:focus, .export-select:focus {
    border-color: var(--accent, #6366f1);
  }

  .export-error {
    color: #ef4444;
    font-size: 12px;
    margin: 0;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
