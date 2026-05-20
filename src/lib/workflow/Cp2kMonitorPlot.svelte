<script lang="ts">
  import type { ConvergencePoint } from '$lib/api/workflow'
  import { lazy_load_plotly, make_target_writable, base_config, observe_resize } from './plotly-utils'
  import {
    CP2K_ENERGY_SERIES, CP2K_FORCE_SERIES, CP2K_TEMPERATURE_SERIES,
    CP2K_MD_POTENTIAL_SERIES, CP2K_MD_KINETIC_SERIES, CP2K_MD_CONSERVED_SERIES,
    build_traces, build_single_axis_layout,
  } from './monitor-series'

  let {
    points = [],
    running = false,
    mode = `opt`,
    message = ``,
  }: {
    points: ConvergencePoint[]
    running?: boolean
    /** `opt` (geo/cell): Energy + Force panels.
     *  `md`: Potential/Kinetic/Conserved + Temperature panels.
     *  Picked by parent based on node type / software param. */
    mode?: `opt` | `md`
    /** Optional status text from the convergence parser — surfaces e.g.
     *  "cp2k.out not found or empty" or "0 MD steps parsed" in the
     *  placeholder so the user knows whether to wait or investigate. */
    message?: string
  } = $props()

  // One ref + Plotly instance per panel — Plotly.react needs a stable DOM
  // node per plot. Using bind:this on each in a sub-block keeps each chart
  // independent so toggling one trace doesn't reflow the others.
  let energy_div: HTMLDivElement | undefined = $state()
  let force_div: HTMLDivElement | undefined = $state()
  let temp_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  // For MD mode: which energy quantity to plot. Three quantities (Potential
  // ~-3360 eV, Kinetic ~0.6 eV, Conserved ~-3360 eV) collide if plotted on
  // a shared y-axis — pick one at a time via tab switcher. OPT mode shows
  // total energy directly so this state is unused there.
  let md_energy_view: `total` | `potential` | `kinetic` | `conserved` = $state(`total`)

  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => Plotly = p)
    }
  })

  // Each panel is its own effect — Plotly.react is idempotent and fast, and
  // any panel whose div is missing (e.g. MD mode has no force_div) just
  // bails out without affecting the others.

  // Detect which panels actually have meaningful data. The parser's
  // pre-MD-step branch (multi-ENERGY| with no STEP NUMBER block yet)
  // emits points with temperature/kinetic/conserved all zero — without
  // these guards the Temperature panel would draw a flat line at 0 K
  // (looks like "a few K", not the actual ~300 K) and the multi-line
  // Energies panel would show two coincident traces. Hide the panel
  // entirely until the MD STEP NUMBER block kicks in and populates the
  // real values.
  const has_temperature = $derived(points.some((p) => (p.temperature ?? 0) > 0))
  const has_md_thermo = $derived(points.some(
    (p) => (p.kinetic_energy ?? 0) !== 0 || (p.conserved_energy ?? 0) !== 0,
  ))
  const has_forces = $derived(points.some(
    (p) => (p.max_force ?? 0) > 0 || (p.rms_force ?? 0) > 0,
  ))

  // `uirevision` is omitted on purpose — Plotly auto-bumps it whenever
  // data changes, which is exactly the behavior we want for live
  // monitoring: each new point re-fits the axis range so the user sees
  // the full trajectory, not a tiny window stuck at the initial point's
  // value. The cost is that mid-poll zoom gestures are reset on the
  // next 15 s tick — acceptable for live charts; user can wait for the
  // task to complete to zoom freely. Double-click also resets the view.

  $effect(() => {
    if (!Plotly || !energy_div || points.length === 0) return
    // MD mode + has thermodynamic breakdown → user picks one of
    // Total / Potential / Kinetic / Conserved via the tab bar.
    // Otherwise (OPT, or MD before STEP NUMBER block) → simple Total.
    let series = CP2K_ENERGY_SERIES
    let ytitle = `Energy (eV)`
    if (mode === `md` && has_md_thermo) {
      if (md_energy_view === `potential`) {
        series = CP2K_MD_POTENTIAL_SERIES
        ytitle = `Potential Energy (eV)`
      } else if (md_energy_view === `kinetic`) {
        series = CP2K_MD_KINETIC_SERIES
        ytitle = `Kinetic Energy (eV)`
      } else if (md_energy_view === `conserved`) {
        series = CP2K_MD_CONSERVED_SERIES
        ytitle = `Conserved Quantity (eV)`
      } else {
        series = CP2K_ENERGY_SERIES
        ytitle = `Total Energy (eV)`
      }
    }
    Plotly.react(
      energy_div,
      build_traces(points, series),
      build_single_axis_layout({ ytitle }),
      base_config(),
    )
  })

  $effect(() => {
    if (!Plotly || !force_div || points.length === 0 || !has_forces) return
    Plotly.react(
      force_div,
      build_traces(points, CP2K_FORCE_SERIES),
      build_single_axis_layout({ ytitle: `Force (eV/Å)` }),
      base_config(),
    )
  })

  $effect(() => {
    if (!Plotly || !temp_div || points.length === 0 || !has_temperature) return
    Plotly.react(
      temp_div,
      build_traces(points, CP2K_TEMPERATURE_SERIES),
      build_single_axis_layout({ ytitle: `Temperature (K)` }),
      base_config(),
    )
  })

  // Resize observers + writable-target mousemove. One per mounted div.
  $effect(() => {
    const divs = [energy_div, force_div, temp_div].filter(Boolean) as HTMLDivElement[]
    const cleanups: Array<() => void> = []
    for (const d of divs) {
      d.addEventListener(`mousemove`, make_target_writable, true)
      const stop = observe_resize(d)
      cleanups.push(() => {
        d.removeEventListener(`mousemove`, make_target_writable, true)
        stop()
      })
    }
    return () => cleanups.forEach((c) => c())
  })

  const empty = $derived(points.length === 0)
</script>

<div class="monitor-stack">
  {#if running}
    <div class="live-badge">● LIVE</div>
  {/if}

  <!-- Energy panel — always shown. In MD mode with thermo data, a tab
       bar lets the user pick Total/Potential/Kinetic/Conserved; otherwise
       just shows Total (OPT) or whatever is parsed (pre-STEP-NUMBER MD). -->
  <div class="panel">
    <div class="panel-header">
      <div class="panel-title">{mode === `md` ? `Energies` : `Energy`}</div>
      {#if mode === `md` && has_md_thermo}
        <div class="tab-bar">
          {#each [
            { id: `total`,     label: `Total` },
            { id: `potential`, label: `Potential` },
            { id: `kinetic`,   label: `Kinetic` },
            { id: `conserved`, label: `Conserved` },
          ] as t}
            <button type="button"
                    class="tab"
                    class:active={md_energy_view === t.id}
                    onclick={() => md_energy_view = t.id as any}>
              {t.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div bind:this={energy_div} class="panel-plot"></div>
    {#if empty}
      <div class="placeholder">
        <div>{running ? `Waiting for first ${mode === `md` ? `MD` : `optimization`} step…` : `No data yet`}</div>
        {#if message}
          <div class="placeholder-sub">{message}</div>
        {/if}
        {#if running}
          <div class="placeholder-sub">Polls every 15 s. Re-parses <code>cp2k.out</code> from HPC.</div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Force panel — OPT mode only. Always rendered (mirrors the
       Temperature panel pattern in MD mode) so the slot stays reserved.
       Plotly mount in the $effect above is gated on has_forces, so when
       no force data is parsed yet (e.g. CP2K still in initial SCF before
       the first OPT step's gradient block) the panel just shows the
       placeholder instead of disappearing. -->
  {#if mode === `opt`}
    <div class="panel">
      <div class="panel-title">Forces</div>
      <div bind:this={force_div} class="panel-plot"></div>
      {#if !has_forces}
        <div class="placeholder">
          <div>{empty ? `Waiting for first step…` : `Waiting for gradient output`}</div>
          <div class="placeholder-sub">
            CP2K writes <code>Max. gradient</code> / <code>RMS gradient</code> in the per-step
            <code>Informations at step</code> convergence block.
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Temperature panel — MD only. Always rendered so the user knows
       the slot exists. When CP2K hasn't yet emitted its first STEP
       NUMBER block (parser's pre-MD-step branch returns temperature=0
       for all points), we show a placeholder instead of plotting zeros;
       the placeholder explains what we're waiting for so the user
       doesn't think "temperature is broken". The Plotly mount is gated
       on has_temperature in the $effect above. -->
  {#if mode === `md`}
    <div class="panel">
      <div class="panel-title">Temperature</div>
      <div bind:this={temp_div} class="panel-plot"></div>
      {#if !has_temperature}
        <div class="placeholder">
          <div>{empty ? `Waiting for first MD step…` : `Waiting for thermostat output`}</div>
          <div class="placeholder-sub">
            CP2K writes <code>TEMPERATURE [K]</code> in the per-step <code>STEP NUMBER</code> block.
            Appears after the first MD step's force evaluation completes.
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .monitor-stack {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .panel {
    position: relative;
    border: 1px solid var(--border-color, #e5e7eb);
    border-radius: 6px;
    padding: 8px 6px 4px;
    background: var(--surface, transparent);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 0 4px 8px;
    padding-right: 4px;
  }

  .panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, #6b7280);
  }

  .tab-bar {
    display: flex;
    gap: 2px;
    background: rgba(127, 127, 127, 0.08);
    border-radius: 4px;
    padding: 2px;
  }

  .tab {
    background: transparent;
    border: 0;
    padding: 3px 8px;
    font-size: 10.5px;
    color: var(--text-muted, #6b7280);
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .tab:hover {
    color: var(--text-color, #374151);
  }

  .tab.active {
    background: var(--surface, #fff);
    color: var(--text-color, #374151);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .panel-plot {
    width: 100%;
    min-height: 200px;
  }

  .placeholder {
    position: absolute;
    inset: 28px 0 0 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    pointer-events: none;
    color: var(--text-muted, #94a3b8);
    font-size: 12px;
    text-align: center;
    padding: 0 12px;
  }

  .placeholder-sub {
    font-size: 10.5px;
    opacity: 0.75;
  }

  .placeholder-sub code {
    background: rgba(127, 127, 127, 0.15);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 10px;
  }

  .live-badge {
    position: absolute;
    top: -4px;
    right: 4px;
    font-size: 12px;
    font-weight: 600;
    color: #ef4444;
    animation: pulse 1.5s ease-in-out infinite;
    z-index: 10;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
