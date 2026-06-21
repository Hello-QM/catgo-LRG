<!-- src/lib/electronic/ExportDpiControl.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n/index.svelte'
  import { compute_export_px } from './export-dims'

  let {
    dpi = $bindable(300),
    width_mm = $bindable(180),
  }: { dpi?: number; width_mm?: number } = $props()

  const DPI_PRESETS = [96, 150, 300, 600]
  const WIDTH_PRESETS = [
    { mm: 88, key: 'structure.export_width_single' },
    { mm: 180, key: 'structure.export_width_double' },
  ]

  // Hydrate once from localStorage (onMount = no effect loop).
  onMount(() => {
    const d = parseFloat(localStorage.getItem('catgo.export.dpi') ?? '')
    const w = parseFloat(localStorage.getItem('catgo.export.width_mm') ?? '')
    if (!Number.isNaN(d)) dpi = d
    if (!Number.isNaN(w)) width_mm = w
  })

  function persist() {
    try {
      localStorage.setItem('catgo.export.dpi', String(dpi))
      localStorage.setItem('catgo.export.width_mm', String(width_mm))
    } catch {}
  }

  // Aspect is plot-dependent; use a representative 0.625 just for the readout.
  const preview = $derived(compute_export_px(width_mm, dpi, 0.625))
  const is_custom = $derived(!WIDTH_PRESETS.some((w) => w.mm === width_mm))
</script>

<details class="export-dpi">
  <summary>{t('structure.export_png_settings')}</summary>
  <div class="export-dpi-body">
    <div class="row">
      <span>{t('structure.export_dpi')}</span>
      <input
        type="number" min="50" max="1200" step="1" class="num"
        value={dpi}
        onchange={(e) => { dpi = parseFloat((e.target as HTMLInputElement).value) || 300; persist() }}
      />
      {#each DPI_PRESETS as d}
        <button class="chip" class:active={dpi === d} onclick={() => { dpi = d; persist() }}>{d}</button>
      {/each}
    </div>
    <div class="row">
      <span>{t('structure.export_width')}</span>
      <select
        value={is_custom ? 'custom' : String(width_mm)}
        onchange={(e) => {
          const v = (e.target as HTMLSelectElement).value
          if (v !== 'custom') { width_mm = parseFloat(v); persist() }
        }}
      >
        {#each WIDTH_PRESETS as w}
          <option value={String(w.mm)}>{t(w.key)}</option>
        {/each}
        <option value="custom">{t('structure.export_width_custom')}</option>
      </select>
      {#if is_custom}
        <input
          type="number" min="10" step="1" class="num"
          value={width_mm}
          onchange={(e) => { width_mm = parseFloat((e.target as HTMLInputElement).value) || 180; persist() }}
        />
      {/if}
    </div>
    <div class="readout">→ ~{preview.width} × {preview.height} px</div>
  </div>
</details>

<style>
  .export-dpi { font-size: 0.85em; }
  .export-dpi-body { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .num { width: 64px; }
  .chip { padding: 1px 6px; cursor: pointer; }
  .chip.active { font-weight: 700; text-decoration: underline; }
  .readout { opacity: 0.7; }
</style>
