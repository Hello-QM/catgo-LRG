import { Color, type Vector3 } from 'three'
import type { ResolvedVisualShading, ResolvedVisualState } from './visual-state'
import { render_style_to_backend } from './visual-state'

type Uniform<T> = { value: T }

export type WebglAtomUniforms = {
  uIsOrthographic?: Uniform<boolean>
  uLightDir?: Uniform<Vector3>
  uAmbientIntensity?: Uniform<number>
  uDirectionalIntensity?: Uniform<number>
  uSpecStrength?: Uniform<number>
  uRoughness?: Uniform<number>
  uMetalness?: Uniform<number>
  uRenderStyle?: Uniform<number>
  uOutlineStrength?: Uniform<number>
  uDepthCueing?: Uniform<number>
  uDepthNear?: Uniform<number>
  uDepthFar?: Uniform<number>
  uDepthCueBgColor?: Uniform<Color>
  uShadowThreshold?: Uniform<number>
  uHighlightThreshold?: Uniform<number>
  uShadowBrightness?: Uniform<number>
}

export function apply_webgl_background(
  renderer: { setClearColor: (color: Color, alpha?: number) => unknown },
  state: ResolvedVisualState,
  scratch: Color,
): void {
  scratch.setRGB(...state.background_linear)
  renderer.setClearColor(scratch, 1)
}

export function apply_webgl_atom_uniforms(
  uniforms: WebglAtomUniforms,
  state: ResolvedVisualState,
): void {
  const shading = state.shading
  if (uniforms.uIsOrthographic) {
    uniforms.uIsOrthographic.value = shading.is_ortho
  }
  uniforms.uLightDir?.value.set(...shading.light_dir)
  if (uniforms.uAmbientIntensity) {
    uniforms.uAmbientIntensity.value = shading.ambient
  }
  if (uniforms.uDirectionalIntensity) {
    uniforms.uDirectionalIntensity.value = shading.directional
  }
  if (uniforms.uSpecStrength) {
    uniforms.uSpecStrength.value = shading.spec_strength
  }
  if (uniforms.uRoughness) uniforms.uRoughness.value = shading.roughness
  if (uniforms.uMetalness) uniforms.uMetalness.value = shading.metalness
  if (uniforms.uRenderStyle) {
    uniforms.uRenderStyle.value = render_style_to_backend(
      state.render_style_source,
      `webgl2`,
    )
  }
  if (uniforms.uOutlineStrength) {
    uniforms.uOutlineStrength.value = shading.outline
  }
  if (uniforms.uDepthCueing) {
    uniforms.uDepthCueing.value = shading.depth_cueing
  }
  if (uniforms.uDepthNear) uniforms.uDepthNear.value = shading.depth_near
  if (uniforms.uDepthFar) uniforms.uDepthFar.value = shading.depth_far
  uniforms.uDepthCueBgColor?.value.setRGB(...shading.depth_bg)
  if (uniforms.uShadowThreshold) {
    uniforms.uShadowThreshold.value = shading.toon_shadow_threshold
  }
  if (uniforms.uHighlightThreshold) {
    uniforms.uHighlightThreshold.value = shading.toon_highlight_threshold
  }
  if (uniforms.uShadowBrightness) {
    uniforms.uShadowBrightness.value = shading.toon_shadow_brightness
  }
}

export function apply_webgpu_background(
  renderer: { set_background: (rgb: [number, number, number]) => unknown },
  state: ResolvedVisualState,
): void {
  renderer.set_background(state.background_linear)
}

export function apply_webgpu_shading(
  renderer: { set_shading: (shading: ResolvedVisualShading) => boolean },
  state: ResolvedVisualState,
): boolean {
  return renderer.set_shading(state.shading)
}
