import { Color, type ColorRepresentation } from 'three'

export type LinearRgb = [number, number, number]

export type ParsedComputedBackground = {
  linear: LinearRgb
  alpha: number
}

export type BackgroundResolutionInput = {
  theme_linear: LinearRgb
  picked: ColorRepresentation
  opacity: number
}

export const srgb_channel_to_linear = (value: number): number =>
  value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4)

export const linear_channel_to_srgb = (value: number): number =>
  value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(Math.max(0, value), 1 / 2.4) - 0.055

const COMPUTED_RGB_RE =
  /^rgba?\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+)))?\s*\)$/i

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Parse the comma-separated rgb()/rgba() form returned by supported browsers.
 *  CSS components arrive in display sRGB; the returned triple is linear RGB. */
export function parse_computed_background(css: string): ParsedComputedBackground | null {
  const match = COMPUTED_RGB_RE.exec(css)
  if (!match) return null

  const channels = match.slice(1, 4).map(Number)
  if (channels.some((value) => !Number.isFinite(value))) return null
  const raw_alpha = match[4] === undefined ? 1 : Number(match[4])
  if (!Number.isFinite(raw_alpha)) return null

  return {
    linear: channels.map((value) =>
      srgb_channel_to_linear(clamp(value, 0, 255) / 255)
    ) as LinearRgb,
    alpha: clamp(raw_alpha, 0, 1),
  }
}

/** Resolve the first sufficiently opaque computed ancestor background.
 *  The returned Color is in Three's linear working space. */
export function find_theme_background(
  start: HTMLElement | null,
  target: Color,
): Color {
  let element = start
  while (element) {
    const parsed = parse_computed_background(getComputedStyle(element).backgroundColor)
    if (parsed && parsed.alpha >= 0.5) {
      return target.setRGB(...parsed.linear)
    }
    element = element.parentElement
  }
  return target.setRGB(0, 0, 0)
}

/** Blend the selected color over the resolved theme background in linear RGB. */
export function resolve_background_linear(
  { theme_linear, picked, opacity }: BackgroundResolutionInput,
  target: Color,
): Color {
  const selected = new Color(picked)
  return target
    .setRGB(...theme_linear)
    .lerp(selected, clamp(opacity, 0, 1))
}
