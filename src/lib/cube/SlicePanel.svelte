<script lang="ts">
  import {
    render_slice_to_canvas,
    render_atoms_to_canvas,
    colormap_css_gradient,
    type SliceResult,
    type AtomSliceInfo,
    type ColormapName,
  } from './slice'
  import { colors } from '$lib/state.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    slice_result,
    atoms_info = null,
    colormap = `RdBu` as ColormapName,
    on_close,
    on_layout_toggle,
  }: {
    slice_result: SliceResult
    atoms_info?: AtomSliceInfo[] | null
    colormap?: ColormapName
    on_close?: () => void
    on_layout_toggle?: () => void
  } = $props()

  let heatmap_canvas: HTMLCanvasElement | undefined = $state()
  let atoms_canvas: HTMLCanvasElement | undefined = $state()
  let slice_range = $state<[number, number] | null>(null)

  // Re-render whenever slice_result, colormap, or atoms change
  $effect(() => {
    if (!heatmap_canvas || !slice_result) return
    slice_range = render_slice_to_canvas(heatmap_canvas, slice_result, colormap)
  })

  $effect(() => {
    if (!atoms_canvas || !slice_result) return
    const atom_list = atoms_info ?? []
    if (atom_list.length > 0) {
      render_atoms_to_canvas(atoms_canvas, slice_result, atom_list, colors.element, colormap)
    } else {
      // If no atoms, just render heatmap
      render_slice_to_canvas(atoms_canvas, slice_result, colormap)
    }
  })

  function export_canvas(canvas: HTMLCanvasElement | undefined, filename: string) {
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement(`a`)
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }, `image/png`)
  }
</script>

<div class="slice-panel">
  <div class="slice-panel-header">
    <span class="slice-panel-title">{t('structure.cube_slice')}</span>
    <div class="slice-panel-controls">
      <button
        class="slice-layout-btn"
        title={t('structure.cube_toggle_slice_layout')}
        onclick={on_layout_toggle}
      >&#x2194;</button>
      <button
        class="slice-export-btn"
        onclick={() => export_canvas(heatmap_canvas, `slice_heatmap.png`)}
      >PNG</button>
      <button
        class="slice-close-btn"
        title={t('structure.cube_close_slice_panel')}
        onclick={on_close}
      >&times;</button>
    </div>
  </div>

  <div class="slice-plot-area">
    <div class="slice-canvases">
      <div class="slice-view-single">
        <span class="slice-view-label">{t('structure.cube_heatmap')}</span>
        <div class="canvas-with-colorbar">
          <canvas bind:this={heatmap_canvas} class="slice-canvas"></canvas>
          {#if slice_range}
            <div class="colorbar">
              <span class="cb-label">{slice_range[1].toExponential(2)}</span>
              <div
                class="cb-gradient"
                style="background: {colormap_css_gradient(colormap)}"
              ></div>
              <span class="cb-label">{slice_range[0].toExponential(2)}</span>
            </div>
          {/if}
        </div>
      </div>
      <div class="slice-view-single">
        <span class="slice-view-label">{t('structure.atoms')}</span>
        <div class="canvas-with-colorbar">
          <canvas bind:this={atoms_canvas} class="slice-canvas"></canvas>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .slice-panel {
    display: flex;
    flex-direction: column;
    background: rgba(20, 20, 30, 0.95);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  :global(.structure.slice-vertical) .slice-panel {
    border-left: none;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .slice-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }
  .slice-panel-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--struct-text-color, #ccc);
  }
  .slice-panel-controls {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .slice-layout-btn, .slice-export-btn, .slice-close-btn {
    padding: 2px 6px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    color: var(--struct-text-color, #ccc);
    cursor: pointer;
    font-size: 0.75em;
  }
  .slice-layout-btn:hover, .slice-export-btn:hover { background: rgba(255, 255, 255, 0.15); }
  .slice-close-btn { color: #f55; }
  .slice-close-btn:hover { background: rgba(255, 60, 60, 0.2); }

  .slice-plot-area {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }
  .slice-canvases {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
  }
  .slice-view-single {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-height: 0;
  }
  .slice-view-label {
    font-size: 0.7em;
    font-weight: 600;
    opacity: 0.7;
    color: var(--struct-text-color, #ccc);
  }
  .canvas-with-colorbar {
    display: flex;
    align-items: stretch;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }
  .slice-canvas {
    flex: 1;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border: 1px solid rgba(128, 128, 128, 0.2);
    border-radius: 4px;
    image-rendering: pixelated;
  }
  .colorbar {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    width: 16px;
    flex-shrink: 0;
  }
  .cb-gradient {
    flex: 1;
    width: 12px;
    border-radius: 2px;
    border: 1px solid rgba(128, 128, 128, 0.3);
  }
  .cb-label {
    font-size: 0.55rem;
    font-family: monospace;
    opacity: 0.7;
    text-align: center;
    line-height: 1;
    color: var(--struct-text-color, #ccc);
  }
</style>
