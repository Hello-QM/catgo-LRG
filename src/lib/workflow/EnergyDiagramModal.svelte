<script lang="ts">
  import EnergyDiagramEditor from './EnergyDiagramEditor.svelte'
  import EnergeticSpanPanel from './EnergeticSpanPanel.svelte'
  import DistortionInteractionPanel from './DistortionInteractionPanel.svelte'
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
  // Latest pathways, so switching tabs remounts the editor with the edits intact
  // and the energetic-span tab analyses what is on screen.
  let current_pathways = $state.raw<any[]>([])
  let tab = $state<'diagram' | 'span' | 'di'>('diagram')

  $effect(() => {
    if (show) {
      current_pathways = initial_pathways
      pending_pathways = null
      tab = `diagram`
    }
  })

  function handle_change(p: any[]) {
    pending_pathways = p
    current_pathways = p
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
      <div class="ed-tabs" role="tablist">
        <button role="tab" class:active={tab === `diagram`} aria-selected={tab === `diagram`}
          onclick={() => (tab = `diagram`)}>{t('workflow.ed_tab_diagram')}</button>
        <button role="tab" class:active={tab === `span`} aria-selected={tab === `span`}
          onclick={() => (tab = `span`)}>{t('workflow.ed_tab_energetic_span')}</button>
        <button role="tab" class:active={tab === `di`} aria-selected={tab === `di`}
          onclick={() => (tab = `di`)}>{t('workflow.ed_tab_distortion_interaction')}</button>
      </div>
      <div class="ed-body">
        {#if tab === `diagram`}
          <EnergyDiagramEditor initial_pathways={current_pathways} onchange={handle_change} />
        {:else if tab === `span`}
          <EnergeticSpanPanel pathways={current_pathways} />
        {/if}
        <!-- Kept mounted so its inputs survive tab switches -->
        <div class:ed-hidden={tab !== `di`}>
          <DistortionInteractionPanel />
        </div>
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
  .ed-tabs {
    display: flex;
    gap: 2px;
    padding: 0 12px;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08));
    overflow-x: auto;
  }
  .ed-tabs button {
    padding: 8px 12px;
    font-size: 12px;
    font-family: inherit;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
    white-space: nowrap;
  }
  .ed-tabs button:hover { color: var(--text-color, #eee); }
  .ed-tabs button.active {
    color: var(--text-color, #eee);
    border-bottom-color: var(--accent-color, #3b82f6);
    font-weight: 600;
  }
  .ed-hidden { display: none; }
  .ed-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    min-height: 0;
  }
</style>
