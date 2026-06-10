<script lang="ts">
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    show = $bindable(),
    label = ``,
    filename,
    generating,
    error,
    content = $bindable(),
    open_count = 0,
    onsave,
    onclose,
  }: {
    show: boolean
    label?: string
    filename: string
    generating: boolean
    error: string
    content: string
    /** Bumped on each open so {#key} always recreates Monaco fresh. */
    open_count?: number
    onsave: () => void
    onclose: () => void
  } = $props()
</script>

{#if show}
  <div class="modal-overlay" onclick={onclose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h3 class="modal-title">{label || t('workflow.input_file')}</h3>
        <div class="modal-actions">
          <button class="save-btn" onclick={onsave}>{t('workflow.save_to_node')}</button>
          <button class="close-btn" onclick={onclose} title={t('common.close')}>&times;</button>
        </div>
      </div>
      <div class="modal-body">
        {#if generating}
          <div class="loading">{t('workflow.generating_file', { name: filename })}</div>
        {:else if error}
          <div class="error-msg">{error}</div>
        {:else}
          {#key `${filename}-${open_count}`}
            <MonacoEditorPanel
              {content}
              {filename}
              onsave={(text) => { content = text }}
              onchange={(text) => { content = text }}
            />
          {/key}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    padding: 16px; overflow: auto;
  }
  .modal {
    width: min(900px, calc(100vw - 32px)); height: min(700px, calc(100vh - 32px));
    background: var(--surface-bg); border: 1px solid var(--border-color); border-radius: 10px;
    display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .modal-header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px; min-width: 0;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08)); flex-shrink: 0;
  }
  .modal-title { font-size: 14px; font-weight: 700; color: var(--text-color, #eee); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .modal-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
  .save-btn {
    padding: 5px 14px; background: var(--accent-color, #3b82f6); border: none; border-radius: 5px;
    color: white; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .save-btn:hover { filter: brightness(1.15); }
  .close-btn {
    padding: 3px 8px; background: none; border: 1px solid var(--border-color);
    border-radius: 5px; color: var(--text-color-muted, #94a3b8); font-size: 16px; cursor: pointer; line-height: 1;
  }
  .close-btn:hover { background: var(--surface-bg-hover); color: var(--text-color, #eee); }
  .modal-body { flex: 1; overflow: hidden; display: flex; }
  .modal-body > :global(*) { width: 100%; }
  .loading, .error-msg {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; font-size: 13px;
  }
  .loading { color: var(--text-color-muted); }
  .error-msg { color: var(--error-color, #ef4444); padding: 24px; text-align: center; }
</style>
