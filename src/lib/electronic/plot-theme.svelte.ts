// Bundle Arimo (Apache-2.0, metric-compatible with Arial) so plots render in an
// Arial-identical face on every OS — real Arial is proprietary and can't ship.
// These side-effect imports register the @font-face globally via Vite.
import '@fontsource/arimo/400.css'
import '@fontsource/arimo/700.css'
import { THEME_TYPE, type ThemeName } from '$lib/theme'

/** Plot font stack — bundled Arimo first, then a real Arial / Arial-clone if the
 *  OS has one, then generic sans-serif. */
export const PLOT_FONT = `Arimo, Arial, 'Liberation Sans', 'Helvetica Neue', sans-serif`

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
  font: string
}

/** Reactive plot colors for the current app theme. Call inside a reactive
 *  context (template / $derived) so plots restyle when the theme changes. */
export function plot_theme_colors(): PlotThemeColors {
  const dark = THEME_TYPE[_theme as ThemeName] !== `light`
  return dark
    ? { text: `#ccc`, grid: `rgba(255,255,255,0.1)`, line: `rgba(200,200,200,0.5)`, tick: `rgba(200,200,200,0.5)`, legend_bg: `rgba(0,0,0,0.3)`, font: PLOT_FONT }
    : { text: `#374151`, grid: `rgba(0,0,0,0.12)`, line: `rgba(60,60,60,0.55)`, tick: `rgba(60,60,60,0.55)`, legend_bg: `rgba(255,255,255,0.6)`, font: PLOT_FONT }
}
