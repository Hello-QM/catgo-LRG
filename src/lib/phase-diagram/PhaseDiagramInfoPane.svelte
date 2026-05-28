<script lang="ts">
  import { DraggablePane } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import PhaseDiagramStats from './PhaseDiagramStats.svelte'
  import type { PhaseStats, PlotEntry3D } from './types'

  load_i18n_module('structure')

  let {
    phase_stats,
    stable_entries,
    unstable_entries,
    max_hull_dist_show_phases,
    max_hull_dist_show_labels,
    label_threshold,
    pane_open = $bindable(false),
    toggle_props = {},
    pane_props = {},
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, `onclose`> & {
    phase_stats: PhaseStats | null
    stable_entries: PlotEntry3D[]
    unstable_entries: PlotEntry3D[]
    max_hull_dist_show_phases: number
    max_hull_dist_show_labels: number
    label_threshold: number
    pane_open?: boolean
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
  } = $props()
</script>

<DraggablePane
  bind:show={pane_open}
  max_width="24em"
  toggle_props={{
    title: pane_open ? `` : t('structure.phase_diagram_info'),
    class: `phase-diagram-info-toggle`,
    ...toggle_props,
  }}
  open_icon="Cross"
  closed_icon="Info"
  pane_props={{
    ...pane_props,
    class: `phase-diagram-info-pane ${pane_props?.class ?? ``}`,
  }}
  {...rest}
>
  <PhaseDiagramStats
    {phase_stats}
    {stable_entries}
    {unstable_entries}
    style="padding: 3pt; background: var(--pane-bg)"
  />

  <section class="vis-settings">
    <h5>{t('structure.phase_visualization_settings')}</h5>
    <div class="setting-item" data-testid="pd-visible-stable">
      <span>{t('structure.phase_visible_stable')}:</span>
      <span>{stable_entries.filter((entry) => entry.visible).length} / {
          stable_entries.length
        }</span>
    </div>
    <div class="setting-item" data-testid="pd-visible-unstable">
      <span>{t('structure.phase_visible_unstable')}:</span>
      <span>{unstable_entries.filter((entry) => entry.visible).length} / {
          unstable_entries.length
        }</span>
    </div>
    <div class="setting-item" data-testid="pd-show-threshold">
      <span>{t('structure.phase_points_threshold')}:</span>
      <span>{max_hull_dist_show_phases.toFixed(3)} eV/atom</span>
    </div>
    <div class="setting-item" data-testid="pd-label-threshold">
      <span>{t('structure.phase_label_threshold')}:</span>
      <span>{max_hull_dist_show_labels.toFixed(3)} eV/atom</span>
    </div>
    <div class="setting-item" data-testid="pd-entry-limit-labels">
      <span>{t('structure.phase_entry_limit_labels')}:</span>
      <span>{t('structure.phase_entries_count', { n: label_threshold })}</span>
    </div>
  </section>

  <section class="usage-tips">
    <h5>{t('structure.phase_usage_tips')}</h5>
    <div class="tips-item"><span>{t('structure.phase_tip_single_click')}:</span><span>{t('structure.phase_tip_select_point')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_double_click')}:</span><span>{t('structure.phase_tip_copy_info')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_drag')}:</span><span>{t('structure.phase_tip_rotate_view')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_scroll')}:</span><span>{t('structure.phase_tip_zoom')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_key_r')}:</span><span>{t('structure.phase_tip_reset_camera')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_key_b')}:</span><span>{t('structure.phase_tip_toggle_color_mode')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_key_s')}:</span><span>{t('structure.phase_tip_toggle_stable')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_key_u')}:</span><span>{t('structure.phase_tip_toggle_unstable')}</span></div>
    <div class="tips-item"><span>{t('structure.phase_tip_key_l')}:</span><span>{t('structure.phase_tip_toggle_labels')}</span></div>
  </section>
</DraggablePane>

<style>
  .vis-settings, .usage-tips {
    padding: 3pt;
    background: var(--pane-bg, white);
  }
  .vis-settings h5, .usage-tips h5 {
    margin: 0 0 6px 0;
  }
  .setting-item, .tips-item {
    display: flex;
    justify-content: space-between;
    gap: 6pt;
    padding: 1pt;
    line-height: 1.5;
  }
  .setting-item span:first-child, .tips-item span:first-child {
    color: var(--text-color-muted, #666);
  }
</style>
