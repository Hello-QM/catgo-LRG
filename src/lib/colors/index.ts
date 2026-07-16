import { hsl, rgb } from 'd3-color'
import * as d3_sc from 'd3-scale-chromatic'
import type { elem_symbols } from '../labels'
import alloy_colors from './alloy-colors.json' with { type: 'json' }
import dark_mode_colors from './dark-mode-colors.json' with { type: 'json' }
import jmol_colors from './jmol-colors.json' with { type: 'json' }
import jmol_soft_colors from './jmol-soft-colors.json' with { type: 'json' }
import muted_colors from './muted-colors.json' with { type: 'json' }
import pastel_colors from './pastel-colors.json' with { type: 'json' }
import vesta_colors from './vesta-colors.json' with { type: 'json' }
import vesta_soft_colors from './vesta-soft-colors.json' with { type: 'json' }

// Extract color scheme interpolate function names from d3-scale-chromatic
export type D3InterpolateName = keyof typeof d3_sc & `interpolate${string}`
export type D3ColorSchemeName = D3InterpolateName extends `interpolate${infer Name}`
  ? Name
  : never
export const COLOR_SCALE_TYPES = [`continuous`, `categorical`] as const
export type ColorScaleType = (typeof COLOR_SCALE_TYPES)[number]

// color values have to be in hex format since that's the only format
// <input type="color"> supports
// https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/color#value
export const default_category_colors: Record<string, string> = {
  'diatomic-nonmetal': `#ec8f3e`, // darkorange
  'noble-gas': `#9857be`, // darkorchid
  'alkali-metal': `#2d7429`, // darkgreen
  'alkaline-earth-metal': `#59529b`, // darkslateblue
  metalloid: `#b7892b`, // darkgoldenrod
  'polyatomic-nonmetal': `#ad4641`, // brown
  'transition-metal': `#6c3a80`,
  'post-transition-metal': `#969050`,
  lanthanide: `#627e98`,
  actinide: `#6a96e4`, // cornflowerblue
}

export const axis_colors = [
  // [axis name, color, hover color]
  [`x`, `#d26462`, `#dd706e`],
  [`y`, `#63b361`, `#6fc06e`],
  [`z`, `#6269cd`, `#7075d9`],
] as const
export const neg_axis_colors = [
  [`nx`, `#bc5654`, `#ca6361`],
  [`ny`, `#55a154`, `#61ae60`],
  [`nz`, `#545bb9`, `#6267c6`],
] as const

export type RGBColor = [number, number, number]
export type ElementColorScheme = Record<(typeof elem_symbols)[number], RGBColor>

const rgb_scheme_to_hex = (obj: Record<string, number[]>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([, val]) => val.length >= 3)
      .map(([key, val]) => [key, rgb(val[0], val[1], val[2]).formatHex()]),
  )

export const vesta_hex = rgb_scheme_to_hex(vesta_colors)
export const jmol_hex = rgb_scheme_to_hex(jmol_colors)
export const alloy_hex = rgb_scheme_to_hex(alloy_colors)
export const pastel_hex = rgb_scheme_to_hex(pastel_colors)
export const muted_hex = rgb_scheme_to_hex(muted_colors)
export const dark_mode_hex = rgb_scheme_to_hex(dark_mode_colors)

// Soften a palette toward a muted, publication-figure look: drop saturation +
// lift lightness. Used only to FILL elements the hand-tabulated soft tables don't
// cover, so every scheme keeps identical (full) element coverage.
const soften_scheme = (scheme: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(scheme).map(([sym, hex]) => {
      const c = hsl(hex)
      c.s *= 0.6
      c.l = Math.min(0.8, c.l * 0.72 + 0.24)
      return [sym, c.formatHex()]
    }),
  )

// Soft palette = the hand-tabulated table's exact value where present, else a
// derived soften of the base. Built over the BASE palette's key set so the soft
// scheme has identical element coverage to its base (a test invariant + no gaps).
const build_soft = (
  base_hex: Record<string, string>,
  table_colors: Record<string, number[]>,
): Record<string, string> => {
  const table = rgb_scheme_to_hex(table_colors)
  const soft = soften_scheme(base_hex)
  return Object.fromEntries(
    Object.keys(base_hex).map((sym) => [sym, table[sym] ?? soft[sym]]),
  )
}

export const vesta_soft_hex = build_soft(vesta_hex, vesta_soft_colors)
export const jmol_soft_hex = build_soft(jmol_hex, jmol_soft_colors)

export const element_color_schemes = {
  Vesta: vesta_hex,
  'Vesta Soft': vesta_soft_hex,
  Jmol: jmol_hex,
  'Jmol Soft': jmol_soft_hex,
  Alloy: alloy_hex,
  Pastel: pastel_hex,
  Muted: muted_hex,
  'Dark Mode': dark_mode_hex,
} as const

export type ColorSchemeName = keyof typeof element_color_schemes
// Default to the SOFT palette so first renders are the muted, publication-figure
// look (matches the config default color_scheme = 'Vesta Soft'). Pick 'Vesta'
// explicitly for the raw high-saturation primaries.
export const default_element_colors = { ...vesta_soft_hex }

// Helper function to detect if a value is a color string
export const is_color = (val: unknown): val is string => {
  if (typeof val !== `string`) return false
  // Check for hex colors, rgb/rgba, hsl/hsla, color(), var(), and named colors
  // Exclude incomplete function prefixes like 'rgb', 'hsl', 'var', 'color'
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|color\([^)]+\)|var\([^)]+\)|(?!rgb$|hsl$|var$|color$)[a-z]+)$/i
    .test(
      val.toString().trim(),
    )
}

export const PLOT_COLORS = [ // Color series for e.g. line plots
  `#64aee4`,
  `#6bc88d`,
  `#e8c380`,
  `#ee8382`,
  `#c9b0eb`,
  `#50c7be`,
  `#e987ad`,
  `#eac4c4`,
  `#add1e6`,
  `#b2e1c1`,
] as const
export const plot_colors = PLOT_COLORS // alias for backwards compatibility

// calculate human-perceived brightness from RGB color
export function luminance(clr: string) {
  const { r, g, b } = rgb(clr)

  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 // https://stackoverflow.com/a/596243
}

// get background color of passed DOM node, or recurse up the DOM tree if current node is transparent
export function get_bg_color(
  elem: HTMLElement | null,
  bg_color: string | null = null,
): string {
  if (bg_color) return bg_color
  // recurse up the DOM tree to find the first non-transparent background color
  const transparent = `rgba(0, 0, 0, 0)`
  if (!elem) return transparent // if no DOM node, return transparent

  const bg = getComputedStyle(elem).backgroundColor // get node background color
  if (bg !== transparent) return bg // if not transparent, return it
  return get_bg_color(elem.parentElement) // otherwise recurse up the DOM tree
}

export interface ContrastOptions {
  bg_color?: string
  luminance_threshold?: number
  choices?: [string, string]
}

export function pick_contrast_color(options: ContrastOptions = {}) {
  const { bg_color, luminance_threshold = 0.7, choices = [`black`, `white`] } = options
  const light_bg = luminance(bg_color ?? `white`) > luminance_threshold
  return light_bg ? choices[0] : choices[1] // dark text for light backgrounds, light for dark
}

// Svelte attachment that automatically picks dark or light text color to maximize contrast with node's background color
export const contrast_color = (options: ContrastOptions = {}) => (node: HTMLElement) => {
  node.style.color = pick_contrast_color({ ...options, bg_color: get_bg_color(node) })
}
