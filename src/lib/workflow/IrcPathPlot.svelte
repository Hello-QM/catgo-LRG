<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  interface IrcStep {
    step: number | string
    dE?: number           // kcal/mol relative to TS
    max_gradient?: number
    rms_gradient?: number
    is_ts?: boolean
    [key: string]: unknown
  }

  let {
    points,
    convergence_thresholds = { max_grad: 0.002, rms_grad: 0.0005 },
  }: {
    points: IrcStep[]
    convergence_thresholds?: { max_grad: number; rms_grad: number }
  } = $props()

  load_i18n_module('workflow')

  // Normalize — fall back to 0/undefined if missing
  const pts = $derived(
    points.map((p) => ({
      ...p,
      step_num: typeof p.step === 'number' ? p.step : parseFloat(String(p.step)) || 0,
      dE: p.dE ?? 0,
    }))
  )

  // SVG layout constants
  const W = 500
  const ML = 60
  const MR = 20
  const MT = 30
  const MB = 40

  const plot_w = W - ML - MR

  // ── Chart 1: Energy Profile (H = 220) ─────────────────────────────────────
  const H1 = 220
  const plot_h1 = H1 - MT - MB

  const n = $derived(pts.length)
  const de_vals = $derived(pts.map((p) => p.dE))
  const min_de = $derived(n > 0 ? Math.min(...de_vals) : -1)
  const max_de = $derived(n > 0 ? Math.max(...de_vals) : 1)
  const de_range = $derived(max_de - min_de || 1)

  const ts_idx = $derived(pts.findIndex((p) => p.is_ts))

  const x_for = $derived((i: number) => ML + (i / Math.max(n - 1, 1)) * plot_w)
  const y_for = $derived((de: number) => MT + plot_h1 - ((de - min_de) / de_range) * plot_h1)

  const backward_pts_str = $derived(
    pts
      .slice(0, ts_idx >= 0 ? ts_idx + 1 : n)
      .map((p, i) => `${x_for(i)},${y_for(p.dE)}`)
      .join(' ')
  )

  const forward_pts_str = $derived(
    ts_idx >= 0
      ? pts
          .slice(ts_idx)
          .map((p, i) => `${x_for(ts_idx + i)},${y_for(p.dE)}`)
          .join(' ')
      : ``
  )

  const y_ticks1 = $derived.by(() => {
    const ticks = []
    for (let i = 0; i <= 4; i++) {
      const val = min_de + (i / 4) * de_range
      ticks.push({ y: MT + plot_h1 - (i / 4) * plot_h1, label: val.toFixed(1) })
    }
    return ticks
  })

  const x_ticks = $derived.by(() => {
    const ticks: { x: number; label: string }[] = []
    const num_ticks = 4
    for (let t = 0; t <= num_ticks; t++) {
      const i = Math.round((t / num_ticks) * Math.max(n - 1, 0))
      ticks.push({ x: x_for(i), label: String(pts[i]?.step_num ?? i + 1) })
    }
    if (ts_idx >= 0) {
      const ts_x = x_for(ts_idx)
      const already_close = ticks.some((tick) => Math.abs(tick.x - ts_x) < 15)
      if (!already_close) {
        ticks.push({ x: ts_x, label: String(pts[ts_idx]?.step_num ?? ts_idx + 1) })
        ticks.sort((a, b) => a.x - b.x)
      }
    }
    return ticks
  })

  // ── Chart 2: Gradient Convergence (H = 170) ───────────────────────────────
  const has_gradient = $derived(pts.some((p) => p.max_gradient !== undefined))
  const H2 = 170
  const plot_h2 = H2 - MT - MB

  const max_g_vals = $derived(pts.map((p) => p.max_gradient ?? 0))
  const rms_g_vals = $derived(pts.map((p) => p.rms_gradient ?? 0))
  const g_ceiling = $derived(
    Math.max(...max_g_vals, convergence_thresholds.max_grad * 1.15)
  )

  const gy = $derived((g: number) => MT + plot_h2 - (g / (g_ceiling || 1)) * plot_h2)

  const max_grad_pts = $derived(
    pts.map((_, i) => `${x_for(i)},${gy(pts[i].max_gradient ?? 0)}`).join(' ')
  )
  const rms_grad_pts = $derived(
    pts.map((_, i) => `${x_for(i)},${gy(pts[i].rms_gradient ?? 0)}`).join(' ')
  )

  const max_thresh_y = $derived(gy(convergence_thresholds.max_grad))
  const rms_thresh_y = $derived(gy(convergence_thresholds.rms_grad))

  const y_ticks2 = $derived.by(() => {
    const ticks = []
    for (let i = 0; i <= 3; i++) {
      const val = (i / 3) * g_ceiling
      ticks.push({ y: MT + plot_h2 - (i / 3) * plot_h2, label: val.toFixed(3) })
    }
    return ticks
  })
</script>

<!-- Chart 1: IRC Energy Profile -->
<svg width={W} height={H1} class="irc-plot" viewBox="0 0 {W} {H1}">
  <!-- Legend -->
  <circle cx={ML + 6} cy={13} r="4" fill="#8b5cf6" />
  <text x={ML + 14} y={17} font-size="11" fill="#64748b">{t('workflow.irc_backward')}</text>
  <circle cx={ML + 80} cy={13} r="5" fill="#ef4444" />
  <text x={ML + 89} y={17} font-size="11" fill="#64748b">{t('workflow.irc_ts')}</text>
  <circle cx={ML + 110} cy={13} r="4" fill="#10b981" />
  <text x={ML + 118} y={17} font-size="11" fill="#64748b">{t('workflow.irc_forward')}</text>

  <!-- Y-axis -->
  <line x1={ML - 5} y1={MT} x2={ML - 5} y2={MT + plot_h1} stroke="#64748b" stroke-width="1" />
  {#each y_ticks1 as tick}
    <line x1={ML - 10} y1={tick.y} x2={ML - 5} y2={tick.y} stroke="#64748b" stroke-width="1" />
    <text x={ML - 12} y={tick.y + 4} font-size="11" fill="#64748b" text-anchor="end">{tick.label}</text>
  {/each}
  <text x={14} y={MT + plot_h1 / 2} font-size="12" fill="#64748b" text-anchor="middle"
    transform="rotate(-90 14 {MT + plot_h1 / 2})">{t('workflow.irc_energy_axis')}</text>

  <!-- X-axis -->
  <line x1={ML} y1={MT + plot_h1} x2={ML + plot_w} y2={MT + plot_h1} stroke="#64748b" stroke-width="1" />
  {#each x_ticks as tick}
    <line x1={tick.x} y1={MT + plot_h1} x2={tick.x} y2={MT + plot_h1 + 5} stroke="#64748b" stroke-width="1" />
    <text x={tick.x} y={MT + plot_h1 + 18} font-size="11" fill="#64748b" text-anchor="middle">{tick.label}</text>
  {/each}
  <text x={ML + plot_w / 2} y={H1 - 3} font-size="12" fill="#64748b" text-anchor="middle">{t('workflow.irc_step_axis')}</text>

  <!-- TS dashed vertical -->
  {#if ts_idx >= 0}
    <line x1={x_for(ts_idx)} y1={MT} x2={x_for(ts_idx)} y2={MT + plot_h1}
      stroke="#f59e0b" stroke-width="1" stroke-dasharray="4,3" />
    <text x={x_for(ts_idx) + 4} y={MT + 12} font-size="10" fill="#f59e0b">{t('workflow.irc_ts')}</text>
  {/if}

  <!-- Backward polyline — purple -->
  {#if backward_pts_str && n > 1}
    <polyline points={backward_pts_str} fill="none" stroke="#8b5cf6" stroke-width="1.5" opacity="0.7" />
  {/if}
  <!-- Forward polyline — teal -->
  {#if forward_pts_str && n > 1}
    <polyline points={forward_pts_str} fill="none" stroke="#10b981" stroke-width="1.5" opacity="0.7" />
  {/if}

  <!-- Data points -->
  {#each pts as pt, i}
    {#if pt.is_ts}
      <circle cx={x_for(i)} cy={y_for(pt.dE)} r="5" fill="#ef4444" stroke="#dc2626" stroke-width="1" />
    {:else if i < ts_idx || ts_idx < 0}
      <circle cx={x_for(i)} cy={y_for(pt.dE)} r="2.5" fill="#8b5cf6" stroke="#8b5cf6" stroke-width="1" />
    {:else}
      <circle cx={x_for(i)} cy={y_for(pt.dE)} r="2.5" fill="#10b981" stroke="#10b981" stroke-width="1" />
    {/if}
  {/each}
</svg>

<!-- Chart 2: Gradient Convergence (only if gradient data is present) -->
{#if has_gradient}
  <svg width={W} height={H2} class="irc-plot" viewBox="0 0 {W} {H2}" style="margin-top:6px">
    <!-- Y-axis -->
    <line x1={ML - 5} y1={MT} x2={ML - 5} y2={MT + plot_h2} stroke="#64748b" stroke-width="1" />
    {#each y_ticks2 as tick}
      <line x1={ML - 10} y1={tick.y} x2={ML - 5} y2={tick.y} stroke="#64748b" stroke-width="1" />
      <text x={ML - 12} y={tick.y + 4} font-size="10" fill="#64748b" text-anchor="end">{tick.label}</text>
    {/each}
    <text x={14} y={MT + plot_h2 / 2} font-size="11" fill="#64748b" text-anchor="middle"
      transform="rotate(-90 14 {MT + plot_h2 / 2})">{t('workflow.irc_gradient_axis')}</text>

    <!-- X-axis -->
    <line x1={ML} y1={MT + plot_h2} x2={ML + plot_w} y2={MT + plot_h2} stroke="#64748b" stroke-width="1" />
    {#each x_ticks as tick}
      <line x1={tick.x} y1={MT + plot_h2} x2={tick.x} y2={MT + plot_h2 + 5} stroke="#64748b" stroke-width="1" />
      <text x={tick.x} y={MT + plot_h2 + 18} font-size="11" fill="#64748b" text-anchor="middle">{tick.label}</text>
    {/each}
    <text x={ML + plot_w / 2} y={H2 - 3} font-size="11" fill="#64748b" text-anchor="middle">{t('workflow.irc_step_axis')}</text>

    <!-- TS dashed vertical -->
    {#if ts_idx >= 0}
      <line x1={x_for(ts_idx)} y1={MT} x2={x_for(ts_idx)} y2={MT + plot_h2}
        stroke="#f59e0b" stroke-width="1" stroke-dasharray="4,3" />
    {/if}

    <!-- Threshold reference lines -->
    {#if max_thresh_y >= MT && max_thresh_y <= MT + plot_h2}
      <line x1={ML} y1={max_thresh_y} x2={ML + plot_w} y2={max_thresh_y}
        stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3" opacity="0.55" />
      <text x={ML + plot_w - 2} y={max_thresh_y - 3} font-size="9" fill="#ef4444" text-anchor="end">{t('workflow.irc_max_gradient_limit')}</text>
    {/if}
    {#if rms_thresh_y >= MT && rms_thresh_y <= MT + plot_h2}
      <line x1={ML} y1={rms_thresh_y} x2={ML + plot_w} y2={rms_thresh_y}
        stroke="#a855f7" stroke-width="1" stroke-dasharray="3,3" opacity="0.55" />
      <text x={ML + plot_w - 2} y={rms_thresh_y - 3} font-size="9" fill="#a855f7" text-anchor="end">{t('workflow.irc_rms_gradient_limit')}</text>
    {/if}

    <!-- Gradient polylines -->
    {#if n > 1}
      <polyline points={max_grad_pts} fill="none" stroke="#ef4444" stroke-width="1.5" opacity="0.8" />
      <polyline points={rms_grad_pts} fill="none" stroke="#a855f7" stroke-width="1.5"
        stroke-dasharray="4,2" opacity="0.8" />
    {/if}

    <!-- Legend -->
    <line x1={ML + 4} y1={MT + 10} x2={ML + 20} y2={MT + 10} stroke="#ef4444" stroke-width="1.5" />
    <text x={ML + 23} y={MT + 14} font-size="9" fill="#64748b">{t('workflow.irc_max_gradient')}</text>
    <line x1={ML + 58} y1={MT + 10} x2={ML + 74} y2={MT + 10} stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4,2" />
    <text x={ML + 77} y={MT + 14} font-size="9" fill="#64748b">{t('workflow.irc_rms_gradient')}</text>
  </svg>
{/if}

<style>
  .irc-plot {
    max-width: 100%;
    height: auto;
    display: block;
  }
</style>
