<script lang="ts">
  import type { MergedPolyhedraGeometry } from './polyhedra'
  import type { PolyhedraOpacityMode } from '$lib/settings'
  import { T, useThrelte } from '@threlte/core'
  import {
    BufferGeometry,
    BufferAttribute,
    ShaderMaterial,
    LineBasicMaterial,
    DoubleSide,
  } from 'three'

  let {
    geometry,
    opacity_mode = `uniform`,
    opacity = 0.4,
    opacity_near = 0.6,
    opacity_far = 0.1,
    edge_color = `#333333`,
    edge_opacity = 0.8,
    show_edges = true,
    camera_position = [0, 0, 50] as [number, number, number],
    depth_range = [0, 100] as [number, number],
  }: {
    geometry: MergedPolyhedraGeometry
    opacity_mode?: PolyhedraOpacityMode
    opacity?: number
    opacity_near?: number
    opacity_far?: number
    edge_color?: string
    edge_opacity?: number
    show_edges?: boolean
    camera_position?: [number, number, number]
    depth_range?: [number, number]
  } = $props()

  // Threlte 8 is render-on-demand: in-place uniform/material mutations below are
  // invisible to its prop-change invalidation (only <T> prop swaps auto-invalidate),
  // so opacity/edge tweaks wouldn't paint until the next pointer event. Invalidate
  // explicitly after each mutation.
  const threlte = useThrelte()

  // --- Face geometry ---
  let face_geom = $derived.by(() => {
    const g = new BufferGeometry()
    if (geometry.face_count === 0) return g
    g.setAttribute(`position`, new BufferAttribute(geometry.face_positions, 3))
    g.setAttribute(`faceColor`, new BufferAttribute(geometry.face_colors, 3))
    g.computeBoundingSphere()
    return g
  })

  // --- Face shader material ---
  const face_vertex_shader = `
    attribute vec3 faceColor;
    varying vec3 vColor;
    varying vec3 vWorldPosition;

    void main() {
      vColor = faceColor;
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `

  const face_fragment_shader = `
    uniform float u_opacity;
    uniform float u_opacity_near;
    uniform float u_opacity_far;
    uniform int u_opacity_mode;
    uniform float u_depth_min;
    uniform float u_depth_max;
    uniform vec3 u_camera_pos;

    varying vec3 vColor;
    varying vec3 vWorldPosition;

    void main() {
      // Flat shading via screen-space derivatives
      vec3 dx = dFdx(vWorldPosition);
      vec3 dy = dFdy(vWorldPosition);
      vec3 normal = normalize(cross(dx, dy));

      // Simple headlamp lighting (view-space)
      vec3 view_dir = normalize(u_camera_pos - vWorldPosition);
      float ndotl = abs(dot(normal, view_dir));
      float light = 0.3 + 0.7 * ndotl;

      // Opacity
      float alpha;
      if (u_opacity_mode == 0) {
        alpha = u_opacity;
      } else {
        float dist = distance(u_camera_pos, vWorldPosition);
        float t = clamp((dist - u_depth_min) / (u_depth_max - u_depth_min + 0.001), 0.0, 1.0);
        alpha = mix(u_opacity_near, u_opacity_far, t);
      }

      gl_FragColor = vec4(vColor * light, alpha);
    }
  `

  let face_material = new ShaderMaterial({
    vertexShader: face_vertex_shader,
    fragmentShader: face_fragment_shader,
    uniforms: {
      u_opacity: { value: 0.4 },
      u_opacity_near: { value: 0.6 },
      u_opacity_far: { value: 0.1 },
      u_opacity_mode: { value: 0 },
      u_depth_min: { value: 0 },
      u_depth_max: { value: 100 },
      u_camera_pos: { value: [0, 0, 50] },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  })

  // Update uniforms reactively without recreating material
  $effect(() => {
    face_material.uniforms.u_opacity.value = opacity
    face_material.uniforms.u_opacity_near.value = opacity_near
    face_material.uniforms.u_opacity_far.value = opacity_far
    face_material.uniforms.u_opacity_mode.value = opacity_mode === `depth_gradient` ? 1 : 0
    face_material.uniforms.u_camera_pos.value = camera_position
    face_material.uniforms.u_depth_min.value = depth_range[0]
    face_material.uniforms.u_depth_max.value = depth_range[1]
    face_material.needsUpdate = true
    threlte.invalidate()
  })

  // --- Edge geometry ---
  let edge_geom = $derived.by(() => {
    const g = new BufferGeometry()
    if (geometry.edge_count === 0) return g
    g.setAttribute(`position`, new BufferAttribute(geometry.edge_positions, 3))
    g.computeBoundingSphere()
    return g
  })

  let edge_material = new LineBasicMaterial({
    color: `#333333`,
    transparent: true,
    opacity: 0.8,
    depthTest: true,
  })

  $effect(() => {
    edge_material.color.set(edge_color)
    edge_material.opacity = edge_opacity
    edge_material.needsUpdate = true
    threlte.invalidate()
  })
</script>

{#if geometry.face_count > 0}
  <T.Mesh
    geometry={face_geom}
    material={face_material}
    frustumCulled={false}
    renderOrder={2}
  />
{/if}

{#if show_edges && geometry.edge_count > 0}
  <T.LineSegments
    geometry={edge_geom}
    material={edge_material}
    frustumCulled={false}
    renderOrder={3}
  />
{/if}
