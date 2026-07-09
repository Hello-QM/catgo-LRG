<script lang="ts">
  import type { MergedPolyhedraGeometry } from './polyhedra'
  import type { PolyhedraOpacityMode } from '$lib/settings'
  import { T, useThrelte } from '@threlte/core'
  import {
    BufferGeometry,
    BufferAttribute,
    ShaderMaterial,
    DoubleSide,
  } from 'three'
  // Fat-line edges (screen-space width, MSAA-friendly) instead of 1-device-pixel
  // GL lines — uniform, crisp outline at any zoom/angle. This is what makes the
  // polyhedra read as clean "frosted-glass" solids rather than wireframe-ish.
  import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
  import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
  import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

  let {
    geometry,
    opacity_mode = `uniform`,
    opacity = 0.4,
    opacity_near = 0.6,
    opacity_far = 0.1,
    whiteness = 0.35,
    edge_color = `#cfd6e2`,
    edge_opacity = 0.8,
    edge_width = 1.5,
    show_edges = true,
    camera_position = [0, 0, 50] as [number, number, number],
    depth_range = [0, 100] as [number, number],
  }: {
    geometry: MergedPolyhedraGeometry
    opacity_mode?: PolyhedraOpacityMode
    opacity?: number
    opacity_near?: number
    opacity_far?: number
    whiteness?: number
    edge_color?: string
    edge_opacity?: number
    edge_width?: number
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
    g.setAttribute(`polyNormal`, new BufferAttribute(geometry.face_normals, 3))
    g.computeBoundingSphere()
    return g
  })

  // --- Face shader material ---
  const face_vertex_shader = `
    attribute vec3 faceColor;
    attribute vec3 polyNormal;
    varying vec3 vColor;
    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vColor = faceColor;
      // Smooth (radial) normal → world space. mat3(modelMatrix) is fine here:
      // the structure model matrix is a rotation/translation, no non-uniform scale.
      vNormal = normalize(mat3(modelMatrix) * polyNormal);
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
    uniform float u_whiteness;
    uniform vec3 u_camera_pos;

    varying vec3 vColor;
    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      // Smooth radial normal (soft glassy gradient, not hard facets).
      vec3 N = normalize(vNormal);
      vec3 V = normalize(u_camera_pos - vWorldPosition);
      float NdotV = abs(dot(N, V));

      // Frosted tint: lift the element hue toward white for a glass look while
      // keeping it identifiable.
      vec3 tint = mix(vColor, vec3(1.0), u_whiteness);

      // Soft diffuse + Fresnel rim glow (bright at grazing silhouette — reads as
      // a glass edge) + a subtle head-lit specular sheen. This is the extra
      // polish over a plain semi-transparent PBR face.
      float diffuse = 0.62 + 0.38 * NdotV;
      float fresnel = pow(1.0 - NdotV, 2.5);
      float spec = pow(NdotV, 26.0) * 0.35;
      vec3 color = tint * diffuse + vec3(1.0) * (fresnel * 0.45 + spec);

      // Base opacity (uniform or depth-graded).
      float alpha;
      if (u_opacity_mode == 0) {
        alpha = u_opacity;
      } else {
        float dist = distance(u_camera_pos, vWorldPosition);
        float t = clamp((dist - u_depth_min) / (u_depth_max - u_depth_min + 0.001), 0.0, 1.0);
        alpha = mix(u_opacity_near, u_opacity_far, t);
      }
      // Densify the rim a touch so silhouettes read as glass edges.
      alpha = mix(alpha, min(1.0, alpha + 0.3), fresnel);

      gl_FragColor = vec4(color, alpha);
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
      u_whiteness: { value: 0.35 },
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
    face_material.uniforms.u_whiteness.value = whiteness
    face_material.uniforms.u_camera_pos.value = camera_position
    face_material.uniforms.u_depth_min.value = depth_range[0]
    face_material.uniforms.u_depth_max.value = depth_range[1]
    face_material.needsUpdate = true
    threlte.invalidate()
  })

  // --- Edge geometry (fat lines) ---
  let edge_geom = $derived.by(() => {
    const g = new LineSegmentsGeometry()
    if (geometry.edge_count === 0) return g
    // edge_positions is already a flat [x,y,z, x,y,z, …] of segment endpoints.
    g.setPositions(geometry.edge_positions as unknown as number[])
    return g
  })

  const edge_material = new LineMaterial({
    color: 0xcfd6e2,
    linewidth: 1.5, // screen-space pixels (worldUnits=false)
    worldUnits: false,
    // alphaToCoverage lets the canvas MSAA anti-alias the line edges (same trick
    // as the atom silhouettes), so thin outlines stay crisp without a dark halo.
    alphaToCoverage: true,
    transparent: true,
    opacity: 0.8,
    depthTest: true,
    depthWrite: false,
  })

  // Fat lines need the drawing-buffer size in pixels; keep it synced on resize.
  $effect(() => {
    const unsub = threlte.size.subscribe((s) => {
      edge_material.resolution.set(s.width, s.height)
      threlte.invalidate()
    })
    return unsub
  })

  $effect(() => {
    edge_material.color.set(edge_color)
    edge_material.opacity = edge_opacity
    edge_material.linewidth = edge_width
    edge_material.needsUpdate = true
    threlte.invalidate()
  })

  // LineSegments2 is a special object (not a plain <T.LineSegments>); build it
  // imperatively and mount via <T is={…}>.
  let edge_line = $derived.by(() => {
    const l = new LineSegments2(edge_geom, edge_material)
    l.frustumCulled = false
    l.renderOrder = 3
    return l
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
  <T is={edge_line} />
{/if}
