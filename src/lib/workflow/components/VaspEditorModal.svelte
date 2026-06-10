<script lang="ts">
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    show = $bindable(),
    vasp_editor_tab = $bindable(),
    vasp_generating,
    vasp_error,
    vasp_incar_content = $bindable(),
    vasp_kpoints_content = $bindable(),
    vasp_poscar_content = $bindable(),
    onsave,
    onclose,
  }: {
    show: boolean
    vasp_editor_tab: `incar` | `kpoints` | `poscar`
    vasp_generating: boolean
    vasp_error: string
    vasp_incar_content: string
    vasp_kpoints_content: string
    vasp_poscar_content: string
    onsave: () => void
    onclose: () => void
  } = $props()
</script>

{#if show}
  <div class="vasp-modal-overlay" onclick={onclose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="vasp-modal" onclick={(e) => e.stopPropagation()}>
      <div class="vasp-modal-header">
        <h3 class="vasp-modal-title">{t('workflow.vasp_input_files')}</h3>
        <div class="vasp-tabs">
          <button class="vasp-tab" class:active={vasp_editor_tab === 'incar'} onclick={() => vasp_editor_tab = 'incar'}>INCAR</button>
          <button class="vasp-tab" class:active={vasp_editor_tab === 'kpoints'} onclick={() => vasp_editor_tab = 'kpoints'}>KPOINTS</button>
          <button class="vasp-tab" class:active={vasp_editor_tab === 'poscar'} onclick={() => vasp_editor_tab = 'poscar'}>POSCAR</button>
        </div>
        <div class="vasp-modal-actions">
          <button class="vasp-save-btn" onclick={onsave}>{t('workflow.save_to_node')}</button>
          <button class="vasp-close-btn" onclick={onclose} title={t('common.close')}>&times;</button>
        </div>
      </div>
      <div class="vasp-modal-body">
        {#if vasp_generating}
          <div class="vasp-loading">{t('workflow.generating_vasp_input_files')}</div>
        {:else if vasp_error}
          <div class="vasp-error">{vasp_error}</div>
        {:else}
          {#if vasp_editor_tab === 'incar'}
            {#key 'incar'}
              <MonacoEditorPanel
                content={vasp_incar_content}
                filename="INCAR"
                onsave={(text) => { vasp_incar_content = text }}
              />
            {/key}
          {:else if vasp_editor_tab === 'kpoints'}
            {#key 'kpoints'}
              <MonacoEditorPanel
                content={vasp_kpoints_content}
                filename="KPOINTS"
                onsave={(text) => { vasp_kpoints_content = text }}
              />
            {/key}
          {:else}
            {#key 'poscar'}
              <MonacoEditorPanel
                content={vasp_poscar_content}
                filename="POSCAR"
                readonly={true}
              />
            {/key}
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vasp-modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    padding: 16px; overflow: auto;
  }
  .vasp-modal {
    width: min(900px, calc(100vw - 32px)); height: min(700px, calc(100vh - 32px));
    background: var(--surface-bg); border: 1px solid var(--border-color); border-radius: 10px;
    display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .vasp-modal-header {
    display: flex; align-items: center; gap: 12px; padding: 10px 16px; min-width: 0;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08)); flex-shrink: 0;
  }
  .vasp-modal-title { font-size: 14px; font-weight: 700; color: var(--text-color, #eee); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .vasp-tabs { display: flex; gap: 0; flex: 1; min-width: 0; overflow-x: auto; }
  .vasp-tab {
    padding: 6px 16px; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-color-muted); font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .vasp-tab:hover { color: var(--text-color-muted, #94a3b8); }
  .vasp-tab.active { color: light-dark(#7c3aed, #a78bfa); border-bottom-color: light-dark(#7c3aed, #a78bfa); }
  .vasp-modal-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .vasp-save-btn {
    padding: 5px 14px; background: var(--accent-color, #3b82f6); border: none; border-radius: 5px;
    color: white; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .vasp-save-btn:hover { filter: brightness(1.15); }
  .vasp-close-btn {
    padding: 3px 8px; background: none; border: 1px solid var(--border-color);
    border-radius: 5px; color: var(--text-color-muted, #94a3b8); font-size: 16px; cursor: pointer; line-height: 1;
  }
  .vasp-close-btn:hover { background: var(--surface-bg-hover); color: var(--text-color, #eee); }
  .vasp-modal-body { flex: 1; overflow: hidden; display: flex; }
  .vasp-modal-body > :global(*) { width: 100%; }
  .vasp-loading, .vasp-error {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; font-size: 13px;
  }
  .vasp-loading { color: var(--text-color-muted); }
  .vasp-error { color: var(--error-color, #ef4444); padding: 24px; text-align: center; }
</style>
