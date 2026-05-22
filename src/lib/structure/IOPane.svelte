<script lang="ts">
  import { DraggablePane, Icon } from '$lib'
  import type { AnyStructure } from '$lib'
  import ExportPane from './ExportPane.svelte'
  import type { CropRegion } from '$lib/io/export'
  import type { Snippet } from 'svelte'
  import type { Camera, Scene } from 'three'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  export type IOTab = 'import' | 'export'

  let {
    show = $bindable(false),
    active_tab = $bindable<IOTab>('import'),
    max_height = '',
    on_open_file = () => {},
    on_paste_content = () => {},
    on_search_database = () => {},
    // Export props (passed through to ExportPane)
    structure = undefined,
    wrapper = undefined,
    scene = undefined,
    camera = undefined,
    selected_indices = [],
    on_request_vacuum_box = undefined,
    crop_mode_active = $bindable(false),
    crop_region = $bindable<CropRegion | null>(null),
    trajectory_context,
    children,
  }: {
    show?: boolean
    active_tab?: IOTab
    max_height?: string
    on_open_file?: () => void
    on_paste_content?: () => void
    on_search_database?: () => void
    structure?: AnyStructure
    wrapper?: HTMLDivElement
    scene?: Scene
    camera?: Camera
    selected_indices?: number[]
    on_request_vacuum_box?: () => void
    crop_mode_active?: boolean
    crop_region?: CropRegion | null
    trajectory_context?: { total_frames: number; on_step: (idx: number) => void | Promise<void> }
    children?: Snippet
  } = $props()

  // dummy binding for embedded ExportPane (not used since embedded skips DraggablePane)
  let export_open_dummy = $state(true)
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="32em"
  max_height={max_height || ``}
  pane_props={{ class: 'io-pane' }}
>
  <h4 class="pane-title">I/O</h4>
  <div class="tab-bar">
    <button
      class:active={active_tab === 'import'}
      onclick={() => active_tab = 'import'}
    >
      {t('common.import')}
    </button>
    <button
      class:active={active_tab === 'export'}
      onclick={() => active_tab = 'export'}
    >
      {t('common.export')}
    </button>
  </div>
  <div class="pane-content">
    {#if children}
      {@render children()}
    {:else}
      {#if active_tab === 'import'}
        <section class="action-section">
          <h5>{t('structure.load_structure')}</h5>
          <div class="action-buttons">
            <button class="action-btn" onclick={on_open_file}>
              <Icon icon="ArrowUp" style="width: 14px; height: 14px" />
              {t('structure.open_file_btn')}
            </button>
            <button class="action-btn" onclick={on_paste_content}>
              <Icon icon="Code" style="width: 14px; height: 14px" />
              {t('structure.paste_content')}
            </button>
          </div>
        </section>
        <section class="action-section">
          <h5>{t('structure.search_database')}</h5>
          <div class="action-buttons">
            <button class="action-btn" onclick={on_search_database}>
              <Icon icon="Database" style="width: 14px; height: 14px" />
              {t('structure.search_database')}
            </button>
          </div>
        </section>
        <p class="hint">{t('structure.drag_drop_hint')}</p>
      {:else if active_tab === 'export'}
        <ExportPane
          bind:export_pane_open={export_open_dummy}
          embedded={true}
          {structure}
          {wrapper}
          {scene}
          {camera}
          {selected_indices}
          {on_request_vacuum_box}
          bind:crop_mode_active
          bind:crop_region
          {trajectory_context}
        />
      {/if}
    {/if}
  </div>
</DraggablePane>

<style>
  .tab-bar {
    grid-template-columns: repeat(2, 1fr);
  }
  .action-buttons {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }
  .hint {
    text-align: center;
    margin: 0;
    font-style: italic;
  }
</style>
