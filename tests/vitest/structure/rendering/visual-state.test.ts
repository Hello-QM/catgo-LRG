import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TOON_HIGHLIGHT_THRESHOLD,
  TOON_SHADOW_BRIGHTNESS,
  TOON_SHADOW_THRESHOLD,
  VISUAL_RADIUS_SCALE,
  render_style_to_legacy_impostor,
  render_style_to_backend,
  same_visual_shading,
  style_pbr,
  type ResolvedVisualShading,
} from '$lib/structure/rendering/visual-state'

const shading = (): ResolvedVisualShading => ({
  light_dir: [0, 0, 1],
  is_ortho: false,
  ambient: 0.6,
  directional: 2.2,
  spec_strength: 1,
  roughness: 0.2,
  metalness: 0,
  render_style: 2,
  outline: 0.2,
  depth_cueing: 0.4,
  depth_near: 1,
  depth_far: 9,
  depth_bg: [0.01, 0.01, 0.01],
  toon_shadow_threshold: 0.3,
  toon_highlight_threshold: 0.97,
  toon_shadow_brightness: 0.5,
})

describe(`shared visual state`, () => {
  it(`owns the single atom display-radius scale`, () => {
    expect(VISUAL_RADIUS_SCALE).toBe(0.5)
  })

  it.each([
    [`glossy`, 0, 0],
    [`metallic`, 0, 0],
    [`matte`, 1, 1],
    [`soft`, 1, 1],
    [`flat`, 1, 1],
    [`toon`, 2, 2],
    [`matcap`, 3, 0],
  ] as const)(`maps %s explicitly for WebGL2 and WebGPU`, (style, webgl, webgpu) => {
    expect(render_style_to_backend(style, `webgl2`)).toBe(webgl)
    expect(render_style_to_backend(style, `webgpu`)).toBe(webgpu)
  })

  it.each([
    [`glossy`, 0],
    [`metallic`, 0],
    [`matte`, 1],
    [`soft`, 1],
    [`flat`, 1],
    [`toon`, 2],
    [`matcap`, 0],
  ] as const)(
    `maps %s explicitly for the legacy non-MatCap impostor`,
    (style, legacy) => {
      expect(render_style_to_legacy_impostor(style)).toBe(legacy)
    },
  )

  it.each([
    [`glossy`, 0.2, 0],
    [`metallic`, 0.4, 0.4],
    [`matcap`, 0.2, 0],
    [`matte`, 0.2, 0],
    [`soft`, 0.2, 0],
    [`flat`, 0.2, 0],
    [`toon`, 0.2, 0],
  ] as const)(
    `resolves the %s PBR values from one table`,
    (style, roughness, metalness) => {
      expect(style_pbr(style)).toEqual({ roughness, metalness })
    },
  )

  it(`owns the shared toon thresholds`, () => {
    expect(TOON_SHADOW_THRESHOLD).toBe(0.3)
    expect(TOON_HIGHLIGHT_THRESHOLD).toBe(0.97)
    expect(TOON_SHADOW_BRIGHTNESS).toBe(0.5)
  })

  it(`detects nested-vector changes without reference equality`, () => {
    const a = shading()
    expect(same_visual_shading(a, { ...a, light_dir: [...a.light_dir] })).toBe(true)
    expect(same_visual_shading(a, { ...a, depth_bg: [0.02, 0.01, 0.01] })).toBe(false)
  })

  it(`keeps legacy MatCap fallback and halo radius on explicit shared adapters`, () => {
    const atom_impostors = readFileSync(
      resolve(process.cwd(), `src/lib/structure/AtomImpostors.svelte`),
      `utf8`,
    )
    const selection_highlights = readFileSync(
      resolve(process.cwd(), `src/lib/structure/SelectionHighlights.svelte`),
      `utf8`,
    )

    expect(atom_impostors).toContain(`render_style_to_legacy_impostor(render_style)`)
    expect(atom_impostors).not.toContain(
      'render_style_to_backend(render_style, `webgl2`)',
    )
    expect(selection_highlights).toContain(`VISUAL_RADIUS_SCALE * 1.7`)
    expect(selection_highlights).not.toMatch(/\*\s*0\.85\b/)
  })
})
