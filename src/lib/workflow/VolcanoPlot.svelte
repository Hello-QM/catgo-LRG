<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  let {
    points = [],
    ideal_line = null,
    x_label = `\u0394G_OH (eV)`,
    y_label = `-\u03B7 (V)`,
    width = 400,
    height = 300,
  }: {
    points: { name: string; x: number; y: number }[]
    ideal_line: { x: number[]; y: number[] } | null
    x_label?: string
    y_label?: string
    width?: number
    height?: number
  } = $props()

  const pad = { top: 30, right: 30, bottom: 40, left: 50 }

  let hovered = $state<number | null>(null)

  // Compute data range with 10% padding
  const x_extent = $derived.by(() => {
    if (points.length === 0) return { min: 0, max: 1 }
    let xs = points.map(p => p.x)
    if (ideal_line) xs = xs.concat(ideal_line.x)
    const min = Math.min(...xs)
    const max = Math.max(...xs)
    const span = max - min || 1
    return { min: min - span * 0.1, max: max + span * 0.1 }
  })

  const y_extent = $derived.by(() => {
    if (points.length === 0) return { min: 0, max: 1 }
    let ys = points.map(p => p.y)
    if (ideal_line) ys = ys.concat(ideal_line.y)
    const min = Math.min(...ys)
    const max = Math.max(...ys)
    const span = max - min || 1
    return { min: min - span * 0.1, max: max + span * 0.1 }
  })

  const plot_w = $derived(width - pad.left - pad.right)
  const plot_h = $derived(height - pad.top - pad.bottom)

  function sx(v: number) {
    return pad.left + ((v - x_extent.min) / (x_extent.max - x_extent.min)) * plot_w
  }

  function sy(v: number) {
    // SVG y is inverted: higher values go up
    return pad.top + (1 - (v - y_extent.min) / (y_extent.max - y_extent.min)) * plot_h
  }

  // Generate nice tick values
  function make_ticks(min: number, max: number, count: number = 5): number[] {
    const range = max - min
    if (range === 0) return [min]
    const rough_step = range / count
    const mag = Math.pow(10, Math.floor(Math.log10(rough_step)))
    const nice = rough_step / mag
    let step: number
    if (nice <= 1.5) step = 1 * mag
    else if (nice <= 3.5) step = 2 * mag
    else if (nice <= 7.5) step = 5 * mag
    else step = 10 * mag

    const ticks: number[] = []
    let t = Math.ceil(min / step) * step
    while (t <= max) {
      ticks.push(t)
      t += step
    }
    return ticks
  }

  const x_ticks = $derived(make_ticks(x_extent.min, x_extent.max))
  const y_ticks = $derived(make_ticks(y_extent.min, y_extent.max))

  // Ideal volcano polyline points string
  const volcano_path = $derived.by(() => {
    if (!ideal_line || ideal_line.x.length === 0) return ''
    return ideal_line.x.map((xv, i) => `${sx(xv)},${sy(ideal_line!.y[i])}`).join(' ')
  })

  function fmt(v: number): string {
    return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)
  }
</script>

<div class="vp-root">
  {#if points.length === 0}
    <div class="vp-empty">{t('workflow.volcano_no_data')}</div>
  {:else}
    <svg
      viewBox="0 0 {width} {height}"
      class="vp-svg"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- Grid lines -->
      {#each x_ticks as tx}
        <line
          x1={sx(tx)} y1={pad.top}
          x2={sx(tx)} y2={pad.top + plot_h}
          class="vp-grid"
        />
      {/each}
      {#each y_ticks as ty}
        <line
          x1={pad.left} y1={sy(ty)}
          x2={pad.left + plot_w} y2={sy(ty)}
          class="vp-grid"
        />
      {/each}

      <!-- Axes -->
      <line
        x1={pad.left} y1={pad.top + plot_h}
        x2={pad.left + plot_w} y2={pad.top + plot_h}
        class="vp-axis"
      />
      <line
        x1={pad.left} y1={pad.top}
        x2={pad.left} y2={pad.top + plot_h}
        class="vp-axis"
      />

      <!-- X tick marks and labels -->
      {#each x_ticks as tx}
        <line
          x1={sx(tx)} y1={pad.top + plot_h}
          x2={sx(tx)} y2={pad.top + plot_h + 4}
          class="vp-tick"
        />
        <text
          x={sx(tx)}
          y={pad.top + plot_h + 16}
          class="vp-tick-label"
          text-anchor="middle"
        >{fmt(tx)}</text>
      {/each}

      <!-- Y tick marks and labels -->
      {#each y_ticks as ty}
        <line
          x1={pad.left - 4} y1={sy(ty)}
          x2={pad.left} y2={sy(ty)}
          class="vp-tick"
        />
        <text
          x={pad.left - 8}
          y={sy(ty) + 3}
          class="vp-tick-label"
          text-anchor="end"
        >{fmt(ty)}</text>
      {/each}

      <!-- X axis label -->
      <text
        x={pad.left + plot_w / 2}
        y={height - 4}
        class="vp-axis-label"
        text-anchor="middle"
      >{x_label}</text>

      <!-- Y axis label -->
      <text
        x={14}
        y={pad.top + plot_h / 2}
        class="vp-axis-label"
        text-anchor="middle"
        transform="rotate(-90, 14, {pad.top + plot_h / 2})"
      >{y_label}</text>

      <!-- Ideal volcano line -->
      {#if volcano_path}
        <polyline
          points={volcano_path}
          class="vp-volcano-line"
        />
      {/if}

      <!-- Scatter points -->
      {#each points as pt, i}
        {@const cx = sx(pt.x)}
        {@const cy = sy(pt.y)}
        <circle
          {cx}
          {cy}
          r={hovered === i ? 7 : 5}
          class="vp-point"
          class:vp-point-hovered={hovered === i}
          onmouseenter={() => (hovered = i)}
          onmouseleave={() => (hovered = null)}
          role="img"
          aria-label="{pt.name}: ({fmt(pt.x)}, {fmt(pt.y)})"
        />
      {/each}

      <!-- Tooltip -->
      {#if hovered !== null && points[hovered]}
        {@const pt = points[hovered]}
        {@const tx = sx(pt.x)}
        {@const ty = sy(pt.y)}
        {@const tip_x = tx + 12}
        {@const tip_y = ty - 12}
        <rect
          x={tip_x - 4}
          y={tip_y - 14}
          width={Math.max(pt.name.length * 6.5 + 80, 120)}
          height={32}
          rx="4"
          class="vp-tooltip-bg"
        />
        <text x={tip_x} y={tip_y} class="vp-tooltip-name">{pt.name}</text>
        <text x={tip_x} y={tip_y + 13} class="vp-tooltip-val">
          x: {fmt(pt.x)}  y: {fmt(pt.y)}
        </text>
      {/if}
    </svg>
  {/if}
</div>

<style>
  .vp-root {
    width: 100%;
    display: flex;
    justify-content: center;
  }

  .vp-svg {
    width: 100%;
    height: auto;
    max-width: 600px;
  }

  .vp-empty {
    text-align: center;
    color: var(--text-muted, #888);
    padding: 24px 0;
    font-size: 12px;
  }

  .vp-grid {
    stroke: var(--vp-grid-color, #333);
    stroke-width: 0.5;
    stroke-dasharray: 4 3;
  }

  .vp-axis {
    stroke: var(--vp-axis-color, #666);
    stroke-width: 1;
  }

  .vp-tick {
    stroke: var(--vp-axis-color, #666);
    stroke-width: 1;
  }

  .vp-tick-label {
    font-size: 9px;
    fill: var(--text-muted, #aaa);
    font-variant-numeric: tabular-nums;
  }

  .vp-axis-label {
    font-size: 11px;
    fill: var(--text-color, #e0e0e0);
    font-weight: 500;
  }

  .vp-volcano-line {
    fill: none;
    stroke: #ef4444;
    stroke-width: 1.5;
    stroke-dasharray: 6 3;
  }

  .vp-point {
    fill: #3b82f6;
    stroke: var(--vp-point-stroke, #1e3a5f);
    stroke-width: 1;
    cursor: pointer;
    transition: r 0.1s ease;
  }

  .vp-point-hovered {
    fill: #60a5fa;
    stroke: #fff;
    stroke-width: 1.5;
  }

  .vp-tooltip-bg {
    fill: var(--bg-secondary, #1e1e1e);
    stroke: var(--border-color, #444);
    stroke-width: 0.5;
    opacity: 0.95;
  }

  .vp-tooltip-name {
    font-size: 10px;
    font-weight: 600;
    fill: var(--text-color, #e0e0e0);
  }

  .vp-tooltip-val {
    font-size: 9px;
    fill: var(--text-muted, #aaa);
    font-variant-numeric: tabular-nums;
  }

  /* Light mode overrides via CSS variables */
  :global(.light) .vp-grid {
    stroke: var(--vp-grid-color, #ddd);
  }

  :global(.light) .vp-axis {
    stroke: var(--vp-axis-color, #999);
  }

  :global(.light) .vp-tick {
    stroke: var(--vp-axis-color, #999);
  }

  :global(.light) .vp-point {
    stroke: var(--vp-point-stroke, #93c5fd);
  }

  :global(.light) .vp-tooltip-bg {
    fill: var(--bg-secondary, #fff);
    stroke: var(--border-color, #ccc);
  }
</style>
