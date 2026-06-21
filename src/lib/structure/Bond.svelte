<script lang="ts">
  import type { BondGroupWithGradients } from '$lib/structure'
  import { untrack } from 'svelte'
  import { T } from '@threlte/core'
  import type { InstancedMesh } from 'three'
  import { Color, CylinderGeometry, InstancedBufferAttribute, Matrix4, ShaderMaterial, Vector3 } from 'three'

  let {
    group,
    saturation = 1.0,
    brightness = 1.0,
    depth_cue_uniforms,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    highlight_strength = 1.0,
  }: {
    group: BondGroupWithGradients
    saturation?: number
    brightness?: number
    depth_cue_uniforms?: {
      uDepthCueing: { value: number }
      uDepthNear: { value: number }
      uDepthFar: { value: number }
      uDepthCueBgColor: { value: Color }
      uOutlineStrength: { value: number }
    }
    /** View-space headlamp direction (x=right, y=up, z=toward camera). Driven
     *  by the light_azimuth/elevation sliders; written live into uLightDir. */
    light_dir?: Vector3
    /** Specular highlight intensity multiplier (highlight_strength setting).
     *  Multiplies the bond glossy spec term; 1.0 = byte-identical legacy look.
     *  Written live into uSpecStrength. */
    highlight_strength?: number
  } = $props()

  let mesh: InstancedMesh | undefined = $state()

  // Grow-only buffers (same pattern as AtomImpostors)
  let colors_start = new Float32Array(0)
  let colors_end = new Float32Array(0)
  let buffer_capacity = 0

  function ensure_buffer(buf: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
    if (buf.length >= needed) return buf
    return new Float32Array(Math.max(needed, buf.length * 2))
  }

  // Color cache to avoid re-parsing hex strings every frame
  const tmp_color = new Color()
  const color_cache = new Map<string, [number, number, number]>()

  function get_linear_color(hex: string): [number, number, number] {
    let cached = color_cache.get(hex)
    if (cached) return cached
    tmp_color.set(hex).convertSRGBToLinear()
    cached = [tmp_color.r, tmp_color.g, tmp_color.b]
    color_cache.set(hex, cached)
    return cached
  }

  const vertex_shader = `
    attribute vec3 instanceColorStart;
    attribute vec3 instanceColorEnd;
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vYPosition;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    varying float vDepthCueZ;

    void main() {
      vColorStart = instanceColorStart;
      vColorEnd = instanceColorEnd;
      vYPosition = position.y;

      // Compute instance normal matrix (inverse-transpose) for correct normals
      // under non-uniform scaling. mat3(instanceMatrix) alone squishes radial
      // normals toward the cylinder axis, producing flat shading.
      // WebGL 1 lacks inverse(), so we use the cofactor (cross-product) trick:
      // cofactor columns are proportional to inverse-transpose columns.
      mat3 m = mat3(instanceMatrix);
      mat3 instanceNormalMat;
      instanceNormalMat[0] = cross(m[1], m[2]);
      instanceNormalMat[1] = cross(m[2], m[0]);
      instanceNormalMat[2] = cross(m[0], m[1]);
      vNormal = normalize(normalMatrix * instanceNormalMat * normal);

      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vViewPosition = mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
      vDepthCueZ = -mvPosition.z;
    }
  `

  const fragment_shader = `
    uniform float ambientIntensity;
    uniform float directionalIntensity;
    uniform float saturation;
    uniform float brightness;
    uniform float uOpacity;
    uniform float uDepthCueing;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uDepthCueBgColor;
    uniform float uOutlineStrength;
    uniform vec3 uLightDir;    // directional light in view space (headlamp, normalized)
    uniform float uSpecStrength;  // glossy specular highlight multiplier (1.0 = default)
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vYPosition;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    varying float vDepthCueZ;

    vec3 linearTosRGB(vec3 linear) {
      return vec3(
        linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0/2.4) - 0.055,
        linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0/2.4) - 0.055,
        linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0/2.4) - 0.055
      );
    }

    void main() {
      vec3 base_color = mix(vColorStart, vColorEnd, vYPosition + 0.5);

      // Desaturate and darken for visual distinction from atoms
      float gray = dot(base_color, vec3(0.299, 0.587, 0.114));
      base_color = mix(vec3(gray), base_color, saturation) * brightness;

      // Blinn-Phong lighting with camera-fixed (headlamp) light direction
      vec3 light_dir = normalize(uLightDir);
      float diffuse = max(dot(vNormal, light_dir), 0.0);
      vec3 viewDir = normalize(-vViewPosition);
      vec3 halfDir = normalize(light_dir + viewDir);
      float specular = pow(max(dot(vNormal, halfDir), 0.0), 60.0);

      // Rim darkening — matches atom curve for dark-edge outline effect.
      // Unlike spheres (center always faces camera → rim≈1), cylinders viewed
      // end-on have all normals perpendicular to view → rim≈0 everywhere.
      // Keep a small ambient floor (0.08) so end-on bonds stay faintly visible.
      float rim = max(dot(vNormal, viewDir), 0.0);
      // Softer rim for bonds — avoid dark bands at atom junctions
      float rim_factor = smoothstep(0.0, 0.25, rim);

      // Higher brightness floor so shadow side doesn't look like a hollow interior
      float lighting = max(ambientIntensity * 0.3 + (ambientIntensity * 0.7 + directionalIntensity * diffuse) * rim_factor, 0.2);
      vec3 final_color = base_color * lighting + vec3(1.0) * specular * 0.4 * uSpecStrength;

      gl_FragColor = vec4(linearTosRGB(final_color), uOpacity);

      // Depth cueing: fade toward background color (VESTA-style)
      if (uDepthCueing > 0.0) {
        float fade = clamp((vDepthCueZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uDepthCueBgColor, fade);
      }

      // Silhouette outline (3Dmol-style): darken cylinder rim. rim already
      // computed above as max(N dot V, 0). 1 - rim is the silhouette factor.
      if (uOutlineStrength > 0.0) {
        float silhouette = smoothstep(0.55, 1.0, 1.0 - rim);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uOutlineStrength);
      }
    }
  `

  // Create material ONCE — update uniforms reactively (no shader recompilation)
  // untrack: initial values are captured intentionally; $effect below keeps them in sync
  const shader_material = untrack(() => new ShaderMaterial({
    vertexShader: vertex_shader,
    fragmentShader: fragment_shader,
    transparent: true,
    depthWrite: true,
    uniforms: {
      ambientIntensity: { value: 0.7 },
      directionalIntensity: { value: 0.3 },
      saturation: { value: saturation },
      brightness: { value: brightness },
      uOpacity: { value: 1 },
      uLightDir: { value: light_dir.clone() }, // view-space headlamp (slider-driven); kept live by $effect below
      uSpecStrength: { value: highlight_strength }, // glossy spec multiplier (slider-driven); kept live by $effect below
      uDepthCueing: depth_cue_uniforms?.uDepthCueing ?? { value: 0 },
      uDepthNear: depth_cue_uniforms?.uDepthNear ?? { value: 0 },
      uDepthFar: depth_cue_uniforms?.uDepthFar ?? { value: 10 },
      uDepthCueBgColor: depth_cue_uniforms?.uDepthCueBgColor ?? { value: new Color(0xffffff) },
      uOutlineStrength: depth_cue_uniforms?.uOutlineStrength ?? { value: 0 },
    },
  }))

  // Update uniforms when props change — no material recreation needed
  $effect(() => {
    const opacity = group?.opacity ?? 1
    shader_material.uniforms.uOpacity.value = opacity
    shader_material.uniforms.ambientIntensity.value = group?.ambient_light ?? 0.7
    shader_material.uniforms.directionalIntensity.value = group?.directional_light ?? 0.3
    shader_material.uniforms.saturation.value = saturation
    shader_material.uniforms.brightness.value = brightness
    shader_material.transparent = opacity < 1
    shader_material.depthWrite = opacity >= 1
    shader_material.depthTest = opacity >= 1
    shader_material.side = opacity < 1 ? 2 : 0

    // Polygon offset to fix Z-fighting with coplanar highlight geometry
    if (group?.polygon_offset) {
      shader_material.polygonOffset = true
      shader_material.polygonOffsetFactor = -1
      shader_material.polygonOffsetUnits = -1
    }
  })

  // Headlamp direction is a plain view-space uniform — copy the slider-derived
  // direction into the live material so bonds re-light the instant it changes.
  $effect(() => {
    shader_material.uniforms.uLightDir.value.copy(light_dir)
  })

  // Specular highlight strength is a plain float uniform — copy the slider value
  // into the live material so bond glossiness changes the instant it moves.
  $effect(() => {
    shader_material.uniforms.uSpecStrength.value = highlight_strength
  })

  // Reactively rebuild geometry when thickness changes
  const geometry = $derived(new CylinderGeometry(
    group?.thickness ?? 0.15,
    group?.thickness ?? 0.15,
    1,
    8,
  ))

  // Main buffer update — grow-only pattern (never destroys mesh or GPU buffers)
  const matrix = new Matrix4()
  const identity_matrix = new Matrix4()

  $effect(() => {
    if (!mesh || !group?.instances) return

    const instances = group.instances
    const count = instances.length

    // Grow instanceMatrix if count exceeds the InstancedMesh's initial capacity.
    // Without this, WebGL reads out-of-bounds and silently skips the draw call.
    const capacity = mesh.instanceMatrix.array.length / 16
    if (count > capacity) {
      const new_capacity = Math.max(count, Math.ceil(capacity * 2))
      const new_array = new Float32Array(new_capacity * 16)
      for (let idx = 0; idx < new_capacity; idx++) {
        identity_matrix.toArray(new_array, idx * 16)
      }
      mesh.instanceMatrix = new InstancedBufferAttribute(new_array, 16)
    }

    // Grow buffers if needed (never shrink — same pattern as AtomImpostors)
    const needed = count * 3
    colors_start = ensure_buffer(colors_start, needed)
    colors_end = ensure_buffer(colors_end, needed)

    // Write instance data
    for (let idx = 0; idx < count; idx++) {
      const instance = instances[idx]
      matrix.fromArray(instance.matrix)
      mesh.setMatrixAt(idx, matrix)

      const [sr, sg, sb] = get_linear_color(instance.color_start)
      const [er, eg, eb] = get_linear_color(instance.color_end)
      const i3 = idx * 3
      colors_start[i3] = sr; colors_start[i3 + 1] = sg; colors_start[i3 + 2] = sb
      colors_end[i3] = er; colors_end[i3 + 1] = eg; colors_end[i3 + 2] = eb
    }

    mesh.instanceMatrix.needsUpdate = true

    // Update color attributes (reuse existing if same buffer)
    for (
      const [name, buffer] of [
        [`instanceColorStart`, colors_start],
        [`instanceColorEnd`, colors_end],
      ] as const
    ) {
      const existing = mesh.geometry.getAttribute(name)
      if (existing?.array === buffer) existing.needsUpdate = true
      else mesh.geometry.setAttribute(name, new InstancedBufferAttribute(buffer, 3))
    }

    // Control visible count without destroying the mesh
    mesh.count = count
  })

</script>

<T.InstancedMesh
  args={[geometry, shader_material, Math.max(group?.instances?.length ?? 0, 1)]}
  bind:ref={mesh}
  raycast={null}
  frustumCulled={false}
  renderOrder={(group?.opacity ?? 1) < 1 ? 1 : 0}
/>
