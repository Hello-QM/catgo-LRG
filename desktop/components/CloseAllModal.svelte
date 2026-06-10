<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { modal } from '../state/modal-state.svelte'

  load_i18n_module('common')

  interface Props {
    execute_close_all: () => void
    close_all_without_saving: () => void
  }

  let { execute_close_all, close_all_without_saving }: Props = $props()
</script>

{#if modal.close_all_visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={() => { if (!modal.close_all_saving) modal.close_all_visible = false }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-dialog close-all-dialog" onclick={(e) => e.stopPropagation()}>
      <h3>{t('app.close_all_tabs')}</h3>
      {#if modal.close_all_entries.length === 0}
        <p>{t('app.no_structures_loaded')}</p>
      {:else}
        <p>{t('app.select_structures_to_save')}</p>
        <div class="close-all-list">
          {#each modal.close_all_entries as entry, i}
            <label class="close-all-entry">
              <input type="checkbox" bind:checked={modal.close_all_entries[i].checked} disabled={modal.close_all_saving || !entry.save_target || entry.save_target === `none`} />
              <span class="close-all-formula">{entry.formula}</span>
              <span class="close-all-target">
                {#if entry.save_target === `local`}
                  &#8594; {entry.save_path?.split(/[/\\]/).pop()}
                {:else if entry.save_target === `hpc`}
                  &#8594; HPC: {entry.save_path?.split(/[/\\]/).pop()}
                {:else if entry.save_target === `database`}
                  &#8594; {t('app.catgo_db')}
                {:else}
                  <span class="close-all-nosave">{t('app.no_save_target')}</span>
                {/if}
              </span>
            </label>
          {/each}
        </div>
      {/if}
      {#if modal.close_all_error}
        <p class="close-all-error">{modal.close_all_error}</p>
      {/if}
      <div class="modal-actions">
        <button class="modal-btn cancel" disabled={modal.close_all_saving} onclick={() => modal.close_all_visible = false}>{t('common.cancel')}</button>
        <button class="modal-btn danger" disabled={modal.close_all_saving} onclick={close_all_without_saving}>{t('common.close')}</button>
        {#if modal.close_all_entries.some(e => e.checked)}
          <button class="modal-btn save" disabled={modal.close_all_saving} onclick={execute_close_all}>
            {modal.close_all_saving ? t('common.saving') : t('app.save_and_close_all')}
          </button>
        {/if}
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
    padding: 16px;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100000050;
    animation: fade-in 0.15s ease-out;
    overflow: auto;
  }

  .modal-dialog {
    background: var(--dialog-bg, var(--surface-bg, #1c1c2e));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 12px;
    padding: 24px;
    min-width: min(320px, calc(100vw - 32px));
    max-width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
    overflow: auto;
  }

  .close-all-dialog {
    max-width: min(480px, calc(100vw - 32px));
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
    flex-wrap: wrap;
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

  .modal-btn.danger {
    background: rgba(220, 38, 38, 0.8);
    border-color: rgba(220, 38, 38, 0.6);
    color: white;
  }

  .modal-btn.danger:hover {
    background: rgba(220, 38, 38, 1);
  }

  .modal-btn.save {
    background: rgba(59, 130, 246, 0.8);
    border-color: rgba(59, 130, 246, 0.5);
    color: white;
  }

  .modal-btn.save:hover:not(:disabled) {
    background: rgba(59, 130, 246, 1);
  }

  .modal-btn.save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .close-all-list {
    max-height: 280px;
    overflow-y: auto;
    margin: 8px 0;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    border-radius: 6px;
    padding: 4px;
  }

  .close-all-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.1s;
  }

  .close-all-entry:hover {
    background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  }

  .close-all-entry input[type="checkbox"] {
    flex-shrink: 0;
  }

  .close-all-formula {
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    min-width: 0;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close-all-target {
    min-width: 0;
    flex: 1;
    color: var(--text-color-muted, #9ca3af);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close-all-nosave {
    opacity: 0.5;
    font-style: italic;
  }

  .close-all-error {
    color: #ef4444;
    font-size: 12px;
    margin: 4px 0;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
