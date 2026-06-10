<script lang="ts">
  import EnergyDiagramEditor from './EnergyDiagramEditor.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    show = $bindable(false),
    initial_pathways = [],
    onsave,
  }: {
    show: boolean
    initial_pathways: any[]
    onsave: (pathways: any[]) => void
  } = $props()

  let pending_pathways: any[] | null = null

  function handle_change(p: any[]) {
    pending_pathways = p
  }

  function save_and_close() {
    if (pending_pathways) onsave(pending_pathways)
    show = false
  }

  function close() {
    show = false
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ed-overlay" onclick={close}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ed-modal" onclick={(e) => e.stopPropagation()}>
      <div class="ed-header">
        <h3 class="ed-title">{t('workflow.energy_diagram_title')}</h3>
        <div class="ed-actions">
          <button class="ed-save-btn" onclick={save_and_close}>{t('common.save_and_close')}</button>
          <button class="ed-close-btn" onclick={close} title={t('common.close')}>&times;</button>
        </div>
      </div>
      <div class="ed-body">
        <EnergyDiagramEditor {initial_pathways} onchange={handle_change} />
      </div>
    </div>
  </div>
{/if}

<style>
  .ed-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
  }
  .ed-modal {
    width: min(900px, calc(100vw - 32px));
    height: min(800px, calc(100vh - 32px));
    background: var(--surface-bg);
    border: 1px solid light-dark(rgba(0,0,0,0.15), rgba(255,255,255,0.15));
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .ed-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 12px;
    min-width: 0;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08));
  }
  .ed-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, #eee);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ed-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .ed-save-btn {
    padding: 5px 14px;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: var(--accent-color, #3b82f6);
    border: 1px solid var(--accent-color, #3b82f6);
    color: #fff;
    font-family: inherit;
  }
  .ed-save-btn:hover { filter: brightness(1.1); }
  .ed-close-btn {
    background: none;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
  }
  .ed-close-btn:hover { color: var(--text-color, #fff); }
  .ed-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    min-height: 0;
  }
</style>
