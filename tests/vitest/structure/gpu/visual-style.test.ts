import { describe, it, expect } from 'vitest'
import { Color } from 'three'
import {
  hex_to_linear_rgb,
  linear_to_display_channel,
  matcap_preset_params,
  normalize_light_dir,
  normalize_lighting,
  render_style_pbr,
  render_style_to_int,
  resolve_background_display_rgb,
} from '$lib/structure/gpu/visual-style'

function expect_rgb_close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(3)
  for (let i = 0; i < 3; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 5)
  }
}

describe(`large-system visual style helpers`, () => {
  it(`converts hex colors to linear RGB once, matching the WebGL color buffer`, () => {
    const expected = new Color(`#808080`)
    expect_rgb_close(hex_to_linear_rgb(`#808080`), [expected.r, expected.g, expected.b])
  })

  it(`resolves opacity 0 to the theme background`, () => {
    expect_rgb_close(
      resolve_background_display_rgb(`#000000`, 0, [1, 1, 1]),
      [1, 1, 1],
    )
  })

  it(`resolves opacity 1 to the picked background color`, () => {
    expect_rgb_close(
      resolve_background_display_rgb(`#000000`, 1, [1, 1, 1]),
      [0, 0, 0],
    )
  })

  it(`resolves picked mid-gray backgrounds in display space for clear color`, () => {
    const rgb = resolve_background_display_rgb(`#808080`, 1, [1, 1, 1])
    for (const v of rgb) expect(v).toBeCloseTo(128 / 255, 4)
  })

  it(`resolves background in display RGB for the WebGPU clear color`, () => {
    const [r, g, b] = resolve_background_display_rgb(`#000000`, 0.5, [1, 1, 1])
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
    expect(r).toBeCloseTo(g, 5)
    expect(g).toBeCloseTo(b, 5)
    expect(r).toBeCloseTo(linear_to_display_channel(0.5), 5)
  })

  it(`maps WebGL render styles to WebGPU material branches`, () => {
    expect(render_style_to_int(`glossy`)).toBe(0)
    expect(render_style_to_int(`metallic`)).toBe(0)
    expect(render_style_to_int(`matte`)).toBe(1)
    expect(render_style_to_int(`soft`)).toBe(1)
    expect(render_style_to_int(`flat`)).toBe(1)
    expect(render_style_to_int(`toon`)).toBe(2)
    expect(render_style_to_int(`matcap`)).toBe(3)
  })

  it(`keeps metallic as the glossy/PBR branch with metallic PBR parameters`, () => {
    expect(render_style_pbr(`glossy`)).toEqual({ roughness: 0.2, metalness: 0 })
    expect(render_style_pbr(`metallic`)).toEqual({ roughness: 0.4, metalness: 0.4 })
  })

  it(`mirrors WebGL procedural MatCap preset parameters`, () => {
    expect(matcap_preset_params(`ceramic`)).toEqual([0.34, 0.66, 0.35, 48, 0.14, 0])
    expect(matcap_preset_params(`pearl`)).toEqual([0.46, 0.48, 0.5, 60, 0.06, 0.18])
    expect(matcap_preset_params(`unknown`)).toEqual(matcap_preset_params(`ceramic`))
  })

  it(`normalizes light vectors and falls back for degenerate input`, () => {
    expect_rgb_close(normalize_light_dir([0, 3, 4]), [0, 0.6, 0.8])
    const fallback = normalize_light_dir([0, 0, 0])
    expect(Math.hypot(...fallback)).toBeCloseTo(1)
  })

  it(`clamps invalid lighting strengths instead of passing negatives to shaders`, () => {
    const lighting = normalize_lighting({
      light_dir: { x: 0, y: 3, z: 4 },
      ambient_light: -1,
      directional_light: 2,
      highlight_strength: -5,
    })
    expect_rgb_close(lighting.light_dir, [0, 0.6, 0.8])
    expect(lighting.ambient_light).toBe(0)
    expect(lighting.directional_light).toBe(2)
    expect(lighting.highlight_strength).toBe(0)
    expect(lighting.depth_cueing).toBe(0)
    expect(lighting.atom_outline_strength).toBe(0)
    expect(lighting.bond_outline_strength).toBe(0)
  })
})
