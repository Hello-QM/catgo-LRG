<script lang="ts">
  import { DraggablePane } from '$lib'
  import type { PDOSResult, DBandResult } from './types'
  import DosPlot from './DosPlot.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    show = $bindable(false),
    dos_result = null,
    dband_result = null,
    show_fermi_line = true,
    show_fill = false,
    show_spin_down = true,
    orientation = `vertical`,
    x_range = null,
    y_range = null,
    show_dband_line = false,
    line_styles = {},
  }: {
    show?: boolean
    dos_result?: PDOSResult | null
    dband_result?: DBandResult | null
    show_fermi_line?: boolean
    show_fill?: boolean
    show_spin_down?: boolean
    orientation?: `horizontal` | `vertical`
    x_range?: [number, number] | null
    y_range?: [number, number] | null
    show_dband_line?: boolean
    line_styles?: Record<string, { dash?: string; width?: number }>
  } = $props()

  let dos_plot: DosPlot | undefined = $state()

  let dband_center_val = $derived(
    show_dband_line && dband_result ? dband_result.center_rel : null
  )

  function download_blob(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement(`a`)
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function export_csv() {
    if (!dos_plot) return
    const csv = dos_plot.export_csv()
    if (csv) download_blob(csv, `dos_data.csv`, `text/csv`)
  }

  async function export_json() {
    if (!dos_plot) return
    const json = dos_plot.export_json()
    if (json) download_blob(json, `dos_data.json`, `application/json`)
  }

  async function export_image(format: `png` | `svg`) {
    if (!dos_plot) return
    const url = await dos_plot.export_image(format)
    if (!url) return
    const a = document.createElement(`a`)
    a.href = url
    a.download = `dos_plot.${format}`
    a.click()
  }
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="700px"
  pane_props={{ class: `dos-plot-window` }}
>
  {#if dos_result}
    <DosPlot
      bind:this={dos_plot}
      grid={dos_result.grid}
      series={dos_result.series}
      efermi={dos_result.efermi}
      {show_fermi_line}
      {show_fill}
      {show_spin_down}
      {orientation}
      {x_range}
      {y_range}
      dband_center_line={dband_center_val}
      {line_styles}
      {...{height: 420} as any}
    />
    <div class="export-bar">
      <button class="btn-small" onclick={() => export_image(`png`)}>PNG</button>
      <button class="btn-small" onclick={() => export_image(`svg`)}>SVG</button>
      <button class="btn-small" onclick={export_csv}>CSV</button>
      <button class="btn-small" onclick={export_json}>JSON</button>
    </div>
  {:else}
    <div class="empty-state">{t('structure.dos_no_data_computed')}</div>
  {/if}
</DraggablePane>

<style>
  :global(.dos-plot-window) {
    min-width: 400px;
    background: var(--pane-bg, rgba(30, 30, 40, 0.95)) !important;
  }
  .export-bar {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 4px 0 0;
  }
  .btn-small {
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    color: var(--text-color, #fff);
    cursor: pointer;
    font-size: 0.82em;
  }
  .btn-small:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  .empty-state {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.4));
    font-size: 0.85em;
  }
</style>
