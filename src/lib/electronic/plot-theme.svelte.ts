import { THEME_TYPE, type ThemeName } from '$lib/theme'

function read_theme(): string {
  if (typeof document === `undefined`) return `light`
  return document.documentElement.getAttribute(`data-theme`) ?? `light`
}

let _theme = $state(read_theme())

if (typeof MutationObserver !== `undefined` && typeof document !== `undefined`) {
  new MutationObserver(() => { _theme = read_theme() }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [`data-theme`],
  })
}

export interface PlotThemeColors {
  text: string
  grid: string
  line: string
  tick: string
  legend_bg: string
}

/** Reactive plot colors for the current app theme. Call inside a reactive
 *  context (template / $derived) so plots restyle when the theme changes. */
export function plot_theme_colors(): PlotThemeColors {
  const dark = THEME_TYPE[_theme as ThemeName] !== `light`
  return dark
    ? { text: `#ccc`, grid: `rgba(255,255,255,0.1)`, line: `rgba(200,200,200,0.5)`, tick: `rgba(200,200,200,0.5)`, legend_bg: `rgba(0,0,0,0.3)` }
    : { text: `#374151`, grid: `rgba(0,0,0,0.12)`, line: `rgba(60,60,60,0.55)`, tick: `rgba(60,60,60,0.55)`, legend_bg: `rgba(255,255,255,0.6)` }
}
