import { describe, expect, it } from 'vitest'
import { polyhedra_styles, SETTINGS_CONFIG } from '$lib/settings'
import { polyhedra_style_to_int } from '$lib/structure/polyhedra'

describe(`polyhedra_style_to_int`, () => {
  it(`maps each style to its shader int`, () => {
    expect(polyhedra_style_to_int(`flat`)).toBe(0)
    expect(polyhedra_style_to_int(`matte`)).toBe(1)
    expect(polyhedra_style_to_int(`glass`)).toBe(2)
  })
})

describe(`polyhedra_style setting`, () => {
  it(`defaults to flat and enumerates all three styles`, () => {
    expect(SETTINGS_CONFIG.structure.polyhedra_style.value).toBe(`flat`)
    expect(Object.keys(SETTINGS_CONFIG.structure.polyhedra_style.enum ?? {})).toEqual([
      ...polyhedra_styles,
    ])
  })

  it(`defaults polyhedra edges to dark #333333 (suits the flat default)`, () => {
    expect(SETTINGS_CONFIG.structure.polyhedra_edge_color.value).toBe(`#333333`)
  })
})
