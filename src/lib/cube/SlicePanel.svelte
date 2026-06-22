<script lang="ts">
  import {
    crop_slice,
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
  let fit_to_atoms = $state(true)
  const SLICE_FIT_MARGIN = 2.5 // Å padding around the atoms when fitting

  // The slice actually drawn: cropped to the atom-bearing region when "fit" is
  // on (so a slab cross-section fills the figure instead of a thin band lost in
  // vacuum), otherwise the full plane.
  let displayed_slice = $derived.by(() => {
    const s = slice_result
    if (!s) return s
    const atoms = atoms_info ?? []
    if (!fit_to_atoms || atoms.length === 0) return s
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const a of atoms) {
      if (a.u < u0) u0 = a.u
      if (a.u > u1) u1 = a.u
      if (a.v < v0) v0 = a.v
      if (a.v > v1) v1 = a.v
    }
    if (!Number.isFinite(u0)) return s
    return crop_slice(
      s, u0 - SLICE_FIT_MARGIN, u1 + SLICE_FIT_MARGIN, v0 - SLICE_FIT_MARGIN, v1 + SLICE_FIT_MARGIN,
    )
  })

  // ── Orientation read-out ───────────────────────────────────────────
  // sample_plane_slice returns the plane geometry in Cartesian (Å):
  //   u_vec = horizontal-axis direction, v_vec = vertical-axis direction,
  //   normal = plane normal, center = plane center, u/v_min/max = extents.
  // Surface it (vectors + a plain-language nearest-axis hint) so the slice can
  // actually be read in space.
  const fmt_vec = (v: readonly [number, number, number]) =>
    `[${v.map((c) => c.toFixed(2)).join(`, `)}]`
  // Nearest cartesian axis, e.g. [0,0,-1] → "−z"; "≈" prefix when not within ~15°.
  const axis_hint = (v: readonly [number, number, number]) => {
    const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])]
    const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2
    const mag = Math.hypot(v[0], v[1], v[2]) || 1
    return `${a[i] / mag > 0.966 ? `` : `≈`}${v[i] >= 0 ? `+` : `−`}${[`x`, `y`, `z`][i]}`
  }
  let orientation = $derived.by(() => {
    const s = displayed_slice
    const full = slice_result
    if (!s || !full) return null
    const uh = axis_hint(full.u_vec)
    const vh = axis_hint(full.v_vec)
    return {
      u: fmt_vec(full.u_vec),
      v: fmt_vec(full.v_vec),
      n: fmt_vec(full.normal),
      center: fmt_vec(full.center),
      u_extent: (s.u_max - s.u_min).toFixed(2),
      v_extent: (s.v_max - s.v_min).toFixed(2),
      readable: `horizontal ${uh} · vertical ${vh}${
        /z/.test(uh) || /z/.test(vh) ? ` · z = depth` : ``
      }`,
    }
  })

  // Re-render whenever slice_result, colormap, or atoms change
  $effect(() => {
    if (!heatmap_canvas || !displayed_slice) return
    slice_range = render_slice_to_canvas(heatmap_canvas, displayed_slice, colormap)
  })

  $effect(() => {
    if (!atoms_canvas || !displayed_slice) return
    const atom_list = atoms_info ?? []
    if (atom_list.length > 0) {
      render_atoms_to_canvas(atoms_canvas, displayed_slice, atom_list, colors.element, colormap)
    } else {
      // If no atoms, just render heatmap
      render_slice_to_canvas(atoms_canvas, displayed_slice, colormap)
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
        class:slice-fit-active={fit_to_atoms}
        title={t('structure.cube_slice_fit')}
        onclick={() => (fit_to_atoms = !fit_to_atoms)}
      >Fit</button>
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

  {#if orientation}
    <div class="slice-orient" title={t('structure.cube_slice_orientation')}>
      <span class="orient-item"><b>u</b> = {orientation.u}</span>
      <span class="orient-item"><b>v</b> = {orientation.v}</span>
      <span class="orient-item"><b>n</b> = {orientation.n}</span>
      <span class="orient-item">
        {t('structure.cube_slice_center')} = {orientation.center}
      </span>
      <span class="orient-item">
        {t('structure.cube_slice_extent')}: u {orientation.u_extent} &times; v
        {orientation.v_extent} &Aring;
      </span>
      <span class="orient-item orient-readable">{orientation.readable}</span>
    </div>
  {/if}

  <div class="slice-plot-area">
    <div class="slice-canvases">
      <div class="slice-view-single">
        <span class="slice-view-label">{t('structure.cube_heatmap')}</span>
        <div class="canvas-with-colorbar">
          <div class="slice-canvas-frame">
            {#if orientation}
              <span class="axis-label axis-v">v {orientation.v}</span>
              <span class="axis-label axis-u">u {orientation.u}</span>
            {/if}
            <canvas bind:this={heatmap_canvas} class="slice-canvas"></canvas>
          </div>
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
          <div class="slice-canvas-frame">
            {#if orientation}
              <span class="axis-label axis-v">v {orientation.v}</span>
              <span class="axis-label axis-u">u {orientation.u}</span>
            {/if}
            <canvas bind:this={atoms_canvas} class="slice-canvas"></canvas>
          </div>
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
  .slice-export-btn.slice-fit-active {
    background: rgba(96, 165, 250, 0.35);
    border-color: rgba(96, 165, 250, 0.6);
    color: #fff;
  }
  .orient-readable {
    color: #9fe6a0;
    opacity: 0.95;
    white-space: nowrap;
  }

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
  .slice-canvas-frame {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    /* leave room for the axis labels along the left/bottom edges */
    padding: 0 0 12px 14px;
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
  /* Orientation read-out bar */
  .slice-orient {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding: 3px 8px 4px;
    font-family: monospace;
    font-size: 0.6rem;
    line-height: 1.3;
    color: var(--struct-text-color, #ccc);
    opacity: 0.85;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }
  .orient-item {
    white-space: nowrap;
  }
  .orient-item b {
    color: #8ab4ff;
    font-weight: 700;
  }
  /* Per-canvas axis direction hints */
  .axis-label {
    position: absolute;
    font-family: monospace;
    font-size: 0.52rem;
    color: var(--struct-text-color, #ccc);
    opacity: 0.6;
    pointer-events: none;
    white-space: nowrap;
  }
  .axis-u {
    left: 50%;
    bottom: 0;
    transform: translateX(-30%);
  }
  .axis-v {
    left: 0;
    top: 50%;
    transform: translateX(-50%) translateY(-50%) rotate(-90deg);
    transform-origin: left center;
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
