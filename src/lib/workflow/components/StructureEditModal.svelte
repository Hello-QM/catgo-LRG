<script lang="ts">
  import type { PymatgenStructure } from '$lib'
  import type { TrajectoryType } from '$lib/trajectory'
  import type { AdsorptionSite } from '$lib/structure/ferrox-wasm-types'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    show = $bindable(),
    label,
    readonly,
    is_trajectory = $bindable(),
    trajectory = $bindable(),
    structure = $bindable(),
    initial_generated,
    scene_props,
    vibration,
    adsorption_sites = [],
    on_adsorption_site_click,
    show_confirm = false,
    onconfirm,
    StructureEditorComponent,
    TrajectoryEditorComponent,
    initial_bulk = null,
    onclose,
    onsave,
    onload_trajectory,
    initial_panel,
    preview_banner = false,
    freeze_mode = false,
    frozen_indices,
    onfreeze_save,
  }: {
    show: boolean
    label: string
    readonly: boolean
    is_trajectory: boolean
    trajectory: TrajectoryType | undefined
    structure: PymatgenStructure | null
    initial_generated?: TrajectoryType | undefined
    scene_props: Record<string, unknown> | undefined
    vibration: { eigenvector: number[][]; base_positions: number[][]; amplitude: number; playing: boolean } | null
    adsorption_sites?: AdsorptionSite[]
    on_adsorption_site_click?: (site_idx: number) => void
    show_confirm?: boolean
    onconfirm?: () => void
    StructureEditorComponent: typeof import('$lib/structure/Structure.svelte').default | null
    TrajectoryEditorComponent: typeof import('$lib/trajectory/Trajectory.svelte').default | null
    initial_bulk?: PymatgenStructure | null
    onclose: () => void
    onsave: (generated?: TrajectoryType) => void
    onload_trajectory?: (traj: TrajectoryType) => void
    initial_panel?: `hpc` | `chat` | `terminal` | `doping` | `slab` | `adsorbate`
    preview_banner?: boolean
    freeze_mode?: boolean
    frozen_indices?: Set<number>
    onfreeze_save?: (indices: number[]) => void
  } = $props()

  let editor_selected_sites = $state<number[]>([])

  type Tab = 'structure' | 'generated'
  let active_tab = $state<Tab>(`structure`)
  let generated_trajectory = $state<TrajectoryType | undefined>(undefined)

  // Reset state when modal opens
  $effect(() => {
    if (show) {
      generated_trajectory = initial_generated ?? undefined
      active_tab = `structure`
    }
  })

  let has_generated = $derived(!!generated_trajectory)
  let gen_count = $derived(generated_trajectory?.frames?.length ?? 0)

  // Called by Structure.svelte when DopingPane/PathwayPane generates structures
  function handle_file_load(event: { trajectory?: TrajectoryType; filename?: string }) {
    if (!event.trajectory) return
    generated_trajectory = event.trajectory
    active_tab = `generated`
    onload_trajectory?.(event.trajectory)
  }

  function handle_save() {
    onsave(generated_trajectory ?? undefined)
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="struct-preview-overlay" onclick={onclose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="struct-edit3d-modal" onclick={(e) => e.stopPropagation()}>
      <div class="struct-preview-header">
        <h3 class="struct-preview-title">{label}</h3>
        {#if has_generated}
          <div class="edit3d-tabs">
            <button class="edit3d-tab" class:active={active_tab === 'structure'} onclick={() => active_tab = 'structure'}>
              {t('workflow.original')}
            </button>
            <button class="edit3d-tab" class:active={active_tab === 'generated'} onclick={() => active_tab = 'generated'}>
              {t('workflow.generated_count', { n: gen_count })}
            </button>
          </div>
        {/if}
        <div class="struct-edit3d-actions">
          {#if show_confirm && onconfirm}
            <button class="struct-edit3d-save" onclick={onconfirm}>{t('common.confirm')}</button>
          {:else if !readonly}
            <button class="struct-edit3d-save" onclick={handle_save}>
              {has_generated ? t('workflow.save_all_and_close') : t('common.save_and_close')}
            </button>
          {/if}
          <button class="struct-preview-close" onclick={onclose} title={t('common.close')}>&times;</button>
        </div>
      </div>
      {#if freeze_mode}
        {@const n_frozen = frozen_indices?.size ?? 0}
        {@const n_total = structure?.sites?.length ?? 0}
        <div class="freeze-toolbar">
          <span class="freeze-toolbar-stat">
            {@html t('workflow.frozen_free_count', { frozen: n_frozen, free: n_total - n_frozen })}
          </span>
          <button class="freeze-tb-btn" disabled={editor_selected_sites.length === 0}
            onclick={() => {
              const next = new Set(frozen_indices ?? new Set<number>())
              for (const i of editor_selected_sites) next.add(i)
              onfreeze_save?.([...next].sort((a, b) => a - b))
            }}>
            {t('workflow.freeze_selected_count', { n: editor_selected_sites.length })}
          </button>
          <button class="freeze-tb-btn" disabled={editor_selected_sites.length === 0}
            onclick={() => {
              const next = new Set(frozen_indices ?? new Set<number>())
              for (const i of editor_selected_sites) next.delete(i)
              onfreeze_save?.([...next].sort((a, b) => a - b))
            }}>
            {t('workflow.unfreeze_selected')}
          </button>
          <button class="freeze-tb-btn"
            onclick={() => {
              const all = new Set(Array.from({ length: n_total }, (_, i) => i))
              const inverted = new Set([...all].filter(i => !(frozen_indices?.has(i))))
              onfreeze_save?.([...inverted].sort((a, b) => a - b))
            }}>
            {t('workflow.multi_preview_invert')}
          </button>
        </div>
      {:else if preview_banner}
        <div class="struct-edit3d-hint" style="background: var(--warning-bg, light-dark(#fef3c7, #44360a)); color: var(--warning-text, light-dark(#92400e, #fbbf24));">{t('workflow.recommend_adsorbate_place_edit')}</div>
      {:else if show_confirm}
        <div class="struct-edit3d-hint">{t('workflow.only_move_adsorbate_hint')}</div>
      {/if}
      <div class="struct-edit3d-body">
        {#if adsorption_sites.length > 0 && readonly && structure}
          <StructurePreview {structure} {adsorption_sites} {on_adsorption_site_click} />
        {:else if active_tab === 'generated' && TrajectoryEditorComponent && generated_trajectory}
          <TrajectoryEditorComponent bind:trajectory={generated_trajectory} structure_props={scene_props ? { scene_props } : {}} />
        {:else if StructureEditorComponent && structure}
          <StructureEditorComponent bind:structure={structure} bind:selected_sites={editor_selected_sites} hide_extra_tools={false} vibration_data={vibration} {scene_props} {initial_bulk} {initial_panel} on_file_load={handle_file_load} />
        {:else}
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-color-dim);">{t('workflow.loading_editor')}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .struct-preview-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
  }
  .struct-preview-header {
    display: flex; align-items: center; padding: 12px 16px; gap: 12px;
    border-bottom: 1px solid light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.08));
  }
  .struct-preview-title {
    margin: 0; font-size: 15px; font-weight: 600; color: var(--text-color, #eee);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .edit3d-tabs {
    display: flex; gap: 2px; background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.06));
    border-radius: 6px; padding: 2px; flex-shrink: 0;
  }
  .edit3d-tab {
    padding: 4px 12px; border: none; border-radius: 4px; font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all 0.15s; font-family: inherit;
    background: transparent; color: var(--text-color-muted, #94a3b8);
  }
  .edit3d-tab.active {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
  }
  .edit3d-tab:not(.active):hover {
    color: var(--text-color, #eee);
  }
  .struct-preview-close {
    background: none; border: none; color: var(--text-color-muted, #94a3b8); font-size: 20px; cursor: pointer; padding: 4px 8px;
  }
  .struct-preview-close:hover { color: var(--text-color, #fff); }
  .struct-edit3d-modal {
    width: min(1100px, 92vw); height: min(800px, 90vh);
    background: var(--surface-bg); border: 1px solid light-dark(rgba(0,0,0,0.15), rgba(255,255,255,0.15)); border-radius: 10px;
    display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .struct-edit3d-actions {
    display: flex; align-items: center; gap: 6px; margin-left: auto;
  }
  .struct-edit3d-save {
    padding: 5px 14px; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer;
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6)); border: 1px solid var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff; font-family: inherit; transition: all 0.15s; white-space: nowrap;
  }
  .struct-edit3d-save:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }
  .struct-edit3d-hint {
    padding: 4px 16px; font-size: 11px; font-weight: 600;
    color: #f59e0b; background: #f59e0b12;
    border-bottom: 1px solid #f59e0b30;
    text-align: center;
  }
  .struct-edit3d-body {
    flex: 1; position: relative; min-height: 0; overflow: hidden;
    --struct-height: 100%;
    --struct-width: 100%;
    --traj-height: 100%;
    --traj-min-height: 0px;
  }

  /* ─── Freeze toolbar ─── */
  .freeze-toolbar {
    display: flex; align-items: center; gap: 8px; padding: 6px 16px;
    background: light-dark(rgba(59,130,246,0.06), rgba(59,130,246,0.1));
    border-bottom: 1px solid light-dark(rgba(59,130,246,0.15), rgba(59,130,246,0.2));
  }
  .freeze-toolbar-stat {
    font-size: 11px; color: var(--text-color, #eee); margin-right: auto;
  }
  .freeze-tb-btn {
    padding: 4px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
    font-family: inherit; cursor: pointer; transition: all 0.12s;
    background: light-dark(rgba(59,130,246,0.12), rgba(59,130,246,0.2));
    border: 1px solid light-dark(rgba(59,130,246,0.25), rgba(59,130,246,0.3));
    color: light-dark(#2563eb, #93c5fd);
  }
  .freeze-tb-btn:hover:not(:disabled) {
    background: light-dark(rgba(59,130,246,0.2), rgba(59,130,246,0.3));
  }
  .freeze-tb-btn:disabled { opacity: 0.4; cursor: default; }
</style>
