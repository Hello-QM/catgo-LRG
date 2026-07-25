/**
 * Appearance → Material style mapping shared by the legacy InstancedMesh
 * atom material (AtomManagerInstances) and the packet/replica impostor path
 * (WebGLReplicaLayer → AtomReplicaRenderer, #533). One source of truth so the
 * two paths can never disagree on what a style means.
 */

export type AtomRenderStyle =
  | `glossy`
  | `metallic`
  | `matte`
  | `soft`
  | `flat`
  | `toon`
  | `matcap`

/**
 * Map onto the shader branches (0 glossy/Blinn-Phong, 1 matte diffuse,
 * 2 toon, 3 matcap). Metallic reuses the specular branch; 2.5D-soft and
 * 2D-flat reuse the matte branch — their distinct look comes from the
 * per-style lighting profile, not a new GLSL branch.
 */
export function render_style_to_int(style: AtomRenderStyle): number {
  if (style === `toon`) return 2
  if (style === `matcap`) return 3
  if (style === `matte` || style === `soft` || style === `flat`) return 1
  return 0
}

/**
 * Per-render-style PBR (roughness, metalness) for the GGX specular branch,
 * ported from pretty-lattice's material presets: glossy = crisp dielectric
 * hot spot, metallic = a bigger/softer, element-colour-tinted highlight.
 */
export function style_pbr(
  style: AtomRenderStyle,
): { roughness: number; metalness: number } {
  return style === `metallic`
    ? { roughness: 0.4, metalness: 0.4 }
    : { roughness: 0.2, metalness: 0.0 }
}
