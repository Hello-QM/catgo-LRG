/**
 * Shared Plotly.js utilities for all chart components.
 * Avoids duplicating lazy-loading, event fixes, and layout defaults.
 */

let _plotly: any = null
let _loading: Promise<any> | null = null

/** Lazily load Plotly.js (singleton, cached). */
export async function lazy_load_plotly(): Promise<any> {
  if (_plotly) return _plotly
  if (_loading) return _loading
  _loading = import(`plotly.js-dist-min`).then((mod) => {
    _plotly = mod.default ?? mod
    _loading = null
    return _plotly
  })
  return _loading
}

/**
 * Fix Plotly's read-only event.target bug in strict mode.
 * Call: `el.addEventListener('mousemove', make_target_writable, true)`
 */
export function make_target_writable(event: Event): void {
  Object.defineProperty(event, 'target', { writable: true, value: event.currentTarget })
}

/** Default Plotly layout merged with overrides. */
export function base_layout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: false,
    plot_bgcolor: `transparent`,
    paper_bgcolor: `transparent`,
    font: {
      family: `'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace`,
      size: 11,
      color: `var(--text-color, #374151)`,
    },
    margin: { l: 60, r: 60, t: 20, b: 40 },
    hovermode: `x unified`,
    ...overrides,
  }
}

/** Default Plotly config (responsive, no toolbar).
 *
 * `scrollZoom: true` enables mousewheel zoom on cartesian axes so users
 * can zoom out past the autoscaled view (we hide the modebar, so without
 * scrollZoom they have no way to zoom out). Double-click on the plot
 * resets to autoscale — Plotly's default gesture, still works with the
 * modebar hidden.
 */
export function base_config(): Record<string, unknown> {
  return {
    responsive: true,
    displayModeBar: false,
    staticPlot: false,
    scrollZoom: true,
    edits: { legendPosition: true },
    doubleClick: `reset+autosize`,
  }
}

/**
 * Observe container resize and call Plotly.Plots.resize().
 * Returns cleanup function for use in Svelte $effect.
 */
export function observe_resize(plot_div: HTMLElement): () => void {
  const ro = new ResizeObserver(() => {
    if (_plotly && plot_div) {
      _plotly.Plots.resize(plot_div)
    }
  })
  ro.observe(plot_div)
  return () => ro.disconnect()
}
