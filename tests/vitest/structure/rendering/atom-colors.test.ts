import { describe, expect, it } from 'vitest'
import type { Site } from '$lib/structure'
import {
  resolve_atom_colors_linear,
  select_packet_atom_colors,
} from '$lib/structure/rendering/atom-colors'

function site(
  element: string,
  properties: Record<string, unknown> = {},
): Site {
  return {
    species: [{ element, occu: 1 } as never],
    abc: [0, 0, 0],
    xyz: [0, 0, 0],
    properties,
  } as Site
}

describe(`resolved atom colors`, () => {
  it(`uses site override, property color, then default element color`, () => {
    const sites = [
      site(`C`, { orig_site_idx: 0 }),
      site(`O`, { orig_unit_cell_idx: 1 }),
      site(`N`),
    ]
    const colors = resolve_atom_colors_linear({
      sites,
      element_colors: { C: `#ffffff`, O: `#ffffff`, N: `#0000ff` },
      property_colors: {
        colors: [`#00ff00`, `#00ffff`],
        values: [0, 1, 2],
      },
      site_color_overrides: new Map([[0, `#ff0000`]]),
    })

    expect(Array.from(colors)).toEqual([
      1, 0, 0,
      0, 1, 1,
      0, 0, 1,
    ])
  })

  it(`keeps plugin color between site overrides and property colors`, () => {
    const colors = resolve_atom_colors_linear({
      sites: [site(`C`), site(`C`)],
      element_colors: { C: `#0000ff` },
      property_colors: {
        colors: [`#00ff00`, `#00ff00`],
        values: [0, 1],
      },
      plugin_colors: [`#ffff00`, `#ffff00`],
      site_color_overrides: new Map([[0, `#ff0000`]]),
    })

    expect(Array.from(colors)).toEqual([
      1, 0, 0,
      1, 1, 0,
    ])
  })

  it(`prefers an authoritative base-color prefix for packet topology`, () => {
    const resolved = new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1, // displayed-only image site, excluded from the base packet
    ])
    const selected = select_packet_atom_colors(resolved, 2)
    expect(Array.from(selected!)).toEqual([1, 0, 0, 0, 1, 0])
    expect(select_packet_atom_colors(new Float32Array(3), 2)).toBeNull()
    expect(select_packet_atom_colors(new Float32Array(7), 2)).toBeNull()
    expect(select_packet_atom_colors(null, 2)).toBeNull()
  })
})
