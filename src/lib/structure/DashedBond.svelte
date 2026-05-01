<script lang="ts">
  import type { BondGroupWithGradients } from '$lib/structure'
  import { untrack } from 'svelte'
  import { T } from '@threlte/core'
  import type { InstancedMesh } from 'three'
  import { Color, CylinderGeometry, InstancedBufferAttribute, Matrix4, ShaderMaterial } from 'three'

  let { group, saturation = 1.0, brightness = 1.0, dash_count = 6.0, dash_ratio = 0.5, depth_cue_uniforms }: {
    group: BondGroupWithGradients
    saturation?: number
    brightness?: number
    dash_count?: number
    dash_ratio?: number
    depth_cue_uniforms?: {
      uDepthCueing: { value: number }
      uDepthNear: { value: number }
      uDepthFar: { value: number }
      uDepthCueBgColor: { value: Color }
      uOutlineStrength: { value: number }       // unused — kept for shape match
      uBondOutlineStrength: { value: number }
    }
  } = $props()

  let mesh: InstancedMesh | undefined = $state()

  // Grow-only buffers (same pattern as Bond.svelte)
  let colors_start = new Float32Array(0)
  let colors_end = new Float32Array(0)

  function ensure_buffer(buf: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
    if (buf.length >= needed) return buf
    return new Float32Array(Math.max(needed, buf.length * 2))
  }

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
    uniform float uDashCount;
    uniform float uDashRatio;
    uniform float uDepthCueing;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uDepthCueBgColor;
    uniform float uBondOutlineStrength;
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
      // Dash pattern along the cylinder axis (vYPosition ranges from -0.5 to 0.5)
      float t = vYPosition + 0.5;  // normalize to 0..1
      float dash = fract(t * uDashCount);
      if (dash > uDashRatio) discard;

      vec3 base_color = mix(vColorStart, vColorEnd, t);

      // Desaturate and darken for visual distinction from atoms
      float gray = dot(base_color, vec3(0.299, 0.587, 0.114));
      base_color = mix(vec3(gray), base_color, saturation) * brightness;

      // Blinn-Phong lighting (VESTA-style headlamp)
      vec3 light_dir = normalize(vec3(0.0, 0.3, 1.0));
      float diffuse = max(dot(vNormal, light_dir), 0.0);
      vec3 viewDir = normalize(-vViewPosition);
      vec3 halfDir = normalize(light_dir + viewDir);
      float specular = pow(max(dot(vNormal, halfDir), 0.0), 100.0);

      // Rim darkening — matches atom curve for dark-edge outline effect.
      // Small ambient floor (0.08) prevents end-on cylinders from going fully black.
      float rim = max(dot(vNormal, viewDir), 0.0);
      float rim_factor = smoothstep(0.0, 0.55, rim);

      vec3 final_color = base_color * (ambientIntensity * 0.08 + (ambientIntensity * 0.92 + directionalIntensity * diffuse) * rim_factor)
                       + vec3(1.0) * specular;

      gl_FragColor = vec4(linearTosRGB(final_color), uOpacity);

      // Depth cueing: fade toward background color (VESTA-style).
      // uDepthCueBgColor is linear-RGB; encode to sRGB to match gl_FragColor.
      if (uDepthCueing > 0.0) {
        float fade = clamp((vDepthCueZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearTosRGB(uDepthCueBgColor), fade);
      }

      // 3Dmol-style silhouette outline. Match BondManagerInstances tuning
      // (wider band + 0.85 multiplier) so dashed H-bonds darken visibly
      // at the user's bond outline setting.
      if (uBondOutlineStrength > 0.0) {
        float silhouette = smoothstep(0.0, 0.6, 1.0 - rim);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uBondOutlineStrength * 0.85);
      }
    }
  `

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
      uDashCount: { value: dash_count },
      uDashRatio: { value: dash_ratio },
      uDepthCueing: depth_cue_uniforms?.uDepthCueing ?? { value: 0 },
      uDepthNear: depth_cue_uniforms?.uDepthNear ?? { value: 0 },
      uDepthFar: depth_cue_uniforms?.uDepthFar ?? { value: 10 },
      uDepthCueBgColor: depth_cue_uniforms?.uDepthCueBgColor ?? { value: new Color(0xffffff) },
      uBondOutlineStrength: depth_cue_uniforms?.uBondOutlineStrength ?? { value: 0 },
    },
  }))

  $effect(() => {
    const opacity = group?.opacity ?? 1
    shader_material.uniforms.uOpacity.value = opacity
    shader_material.uniforms.ambientIntensity.value = group?.ambient_light ?? 0.7
    shader_material.uniforms.directionalIntensity.value = group?.directional_light ?? 0.3
    shader_material.uniforms.saturation.value = saturation
    shader_material.uniforms.brightness.value = brightness
    shader_material.uniforms.uDashCount.value = dash_count
    shader_material.uniforms.uDashRatio.value = dash_ratio
    shader_material.transparent = opacity < 1
    shader_material.depthWrite = opacity >= 1
    shader_material.depthTest = opacity >= 1
    shader_material.side = opacity < 1 ? 2 : 0

    if (group?.polygon_offset) {
      shader_material.polygonOffset = true
      shader_material.polygonOffsetFactor = -1
      shader_material.polygonOffsetUnits = -1
    }
  })

  const geometry = untrack(() => new CylinderGeometry(
    group?.thickness ?? 0.04,
    group?.thickness ?? 0.04,
    1,
    8,
  ))

  const matrix = new Matrix4()

  $effect(() => {
    if (!mesh || !group?.instances) return

    const instances = group.instances
    const count = instances.length

    const needed = count * 3
    colors_start = ensure_buffer(colors_start, needed)
    colors_end = ensure_buffer(colors_end, needed)

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

    mesh.count = count
  })

</script>

<T.InstancedMesh
  args={[geometry, shader_material, Math.max(group?.instances?.length ?? 0, 1)]}
  bind:ref={mesh}
  raycast={null}
  frustumCulled={false}
  renderOrder={(group?.opacity ?? 1) < 1 ? 1 : 0}
>
  <T.CylinderGeometry args={[group?.thickness ?? 0.04, group?.thickness ?? 0.04, 1, 8]} />
</T.InstancedMesh>
