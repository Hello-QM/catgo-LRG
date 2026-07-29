import { Color, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { resolve_view_transform } from '$lib/structure/rendering/view-transform'
import type { ResolvedVisualState } from '$lib/structure/rendering/visual-state'
import {
  apply_webgl_atom_uniforms,
  apply_webgl_background,
  apply_webgpu_background,
  apply_webgpu_shading,
} from '$lib/structure/rendering/visual-adapters'

function fixture(): ResolvedVisualState {
  return {
    render_style_source: `matcap`,
    shading: {
      light_dir: [0.1, 0.2, 0.3],
      is_ortho: true,
      ambient: 0.41,
      directional: 0.67,
      spec_strength: 0.73,
      roughness: 0.2,
      metalness: 0,
      render_style: 0,
      outline: 0.17,
      bond_outline: 0.29,
      depth_cueing: 0.38,
      depth_near: 2.5,
      depth_far: 9.5,
      depth_bg: [0.01, 0.02, 0.03],
      toon_shadow_threshold: 0.3,
      toon_highlight_threshold: 0.97,
      toon_shadow_brightness: 0.5,
    },
    background_linear: [0.04, 0.05, 0.06],
    atom_colors_linear: null,
    view_transform: resolve_view_transform(null, null),
  }
}

describe(`resolved visual-state backend adapters`, () => {
  it(`maps one fixture to exact WebGL background and atom uniforms`, () => {
    const state = fixture()
    const scratch = new Color()
    const webgl = { setClearColor: vi.fn() }
    const uniforms = {
      uIsOrthographic: { value: false },
      uLightDir: { value: new Vector3() },
      uAmbientIntensity: { value: 0 },
      uDirectionalIntensity: { value: 0 },
      uSpecStrength: { value: 0 },
      uRoughness: { value: 0 },
      uMetalness: { value: 0 },
      uRenderStyle: { value: 0 },
      uOutlineStrength: { value: 0 },
      uDepthCueing: { value: 0 },
      uDepthNear: { value: 0 },
      uDepthFar: { value: 0 },
      uDepthCueBgColor: { value: new Color() },
      uShadowThreshold: { value: 0 },
      uHighlightThreshold: { value: 0 },
      uShadowBrightness: { value: 0 },
    }

    apply_webgl_background(webgl, state, scratch)
    apply_webgl_atom_uniforms(uniforms, state)

    expect(webgl.setClearColor).toHaveBeenCalledTimes(1)
    expect(webgl.setClearColor).toHaveBeenCalledWith(scratch, 1)
    expect(scratch.toArray()).toEqual(state.background_linear)
    expect(uniforms.uIsOrthographic.value).toBe(true)
    expect(uniforms.uLightDir.value.toArray()).toEqual(state.shading.light_dir)
    expect(uniforms.uAmbientIntensity.value).toBe(state.shading.ambient)
    expect(uniforms.uDirectionalIntensity.value).toBe(state.shading.directional)
    expect(uniforms.uSpecStrength.value).toBe(state.shading.spec_strength)
    expect(uniforms.uRoughness.value).toBe(state.shading.roughness)
    expect(uniforms.uMetalness.value).toBe(state.shading.metalness)
    expect(uniforms.uRenderStyle.value).toBe(3)
    expect(uniforms.uOutlineStrength.value).toBe(state.shading.outline)
    expect(uniforms.uDepthCueing.value).toBe(state.shading.depth_cueing)
    expect(uniforms.uDepthNear.value).toBe(state.shading.depth_near)
    expect(uniforms.uDepthFar.value).toBe(state.shading.depth_far)
    expect(uniforms.uDepthCueBgColor.value.toArray()).toEqual(state.shading.depth_bg)
    expect(uniforms.uShadowThreshold.value).toBe(state.shading.toon_shadow_threshold)
    expect(uniforms.uHighlightThreshold.value).toBe(state.shading.toon_highlight_threshold)
    expect(uniforms.uShadowBrightness.value).toBe(state.shading.toon_shadow_brightness)
  })

  it(`maps the same fixture to WebGPU with the explicit MatCap fallback`, () => {
    const state = fixture()
    const webgpu = {
      set_background: vi.fn(),
      set_shading: vi.fn(() => true),
    }

    expect(apply_webgpu_background(webgpu, state)).toBeUndefined()
    expect(apply_webgpu_shading(webgpu, state)).toBe(true)
    expect(webgpu.set_background).toHaveBeenCalledWith(state.background_linear)
    expect(webgpu.set_shading).toHaveBeenCalledWith(state.shading)
    expect(state.render_style_source).toBe(`matcap`)
    expect(state.shading.render_style).toBe(0)
  })
})
