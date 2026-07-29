import { Color } from 'three'
import type { ElementSymbol, Site } from '$lib/structure'

export type AtomColorResolutionInput = {
  sites: readonly Site[]
  element_colors?: Partial<Record<ElementSymbol, string>>
  site_color_overrides?: ReadonlyMap<number, string> | null
  property_colors?: {
    colors: readonly string[]
    values?: readonly (number | string)[]
  } | null
  plugin_colors?: readonly (string | null | undefined)[]
  fallback?: string
}

const color = new Color()

/** Pack the WebGL atom color priority into one linear-RGB topology buffer:
 *  site override > plugin > property > element > white. */
export function resolve_atom_colors_linear(
  input: AtomColorResolutionInput,
): Float32Array {
  const out = new Float32Array(input.sites.length * 3)
  for (let site_idx = 0; site_idx < input.sites.length; site_idx++) {
    const site = input.sites[site_idx]
    const orig_idx =
      typeof site.properties?.orig_unit_cell_idx === `number`
        ? site.properties.orig_unit_cell_idx
        : typeof site.properties?.orig_site_idx === `number`
          ? site.properties.orig_site_idx
          : site_idx
    const element = site.species[0]?.element
    const hex =
      input.site_color_overrides?.get(site_idx) ??
      input.plugin_colors?.[site_idx] ??
      input.property_colors?.colors[orig_idx] ??
      (element ? input.element_colors?.[element] : undefined) ??
      input.fallback ??
      `#ffffff`
    color.set(hex)
    out[site_idx * 3] = color.r
    out[site_idx * 3 + 1] = color.g
    out[site_idx * 3 + 2] = color.b
  }
  return out
}

/** Select the authoritative resolved prefix for a base-cell render packet.
 *  StructureScene may resolve extra displayed image sites after the base sites;
 *  those decorative entries must never enlarge packet topology. */
export function select_packet_atom_colors(
  resolved: Float32Array | null | undefined,
  atom_count: number,
  fallback: Float32Array,
): Float32Array {
  const required = Math.max(0, atom_count) * 3
  if (!resolved || resolved.length < required) return fallback
  if (resolved.length === required) return resolved
  return resolved.slice(0, required)
}
