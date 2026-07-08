<script lang="ts">
  // Scene lighting for the 3D viewer: a camera-attached key light, ambient fill,
  // and a zero-asset image-based-lighting (IBL) environment.
  //
  //   • Headlight — the key DirectionalLight tracks the camera each frame so the
  //     highlight stays fixed relative to the view. Orbiting no longer swings the
  //     lighting across the structure (the "product-render" look figure-first
  //     viewers use). Instanced atoms are lit by their own view-space uLightDir
  //     shader; this light + ambient light the PBR surfaces (bonds, polyhedra,
  //     isosurfaces), so the headlight keeps those consistent with the atoms.
  //   • IBL — a procedural RoomEnvironment baked through PMREMGenerator gives PBR
  //     surfaces soft, physically-plausible reflections with no HDR asset to ship
  //     (offline / Tauri safe). Kept at low intensity so it complements the key
  //     and ambient lights rather than washing them out.
  import { T, useTask, useThrelte } from '@threlte/core'
  import { DirectionalLight, PMREMGenerator, type Texture, Vector3 } from 'three'
  import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

  interface Props {
    // Key (directional) light intensity — driven by the active lighting profile.
    directional?: number
    // Ambient fill intensity — driven by the active lighting profile.
    ambient?: number
    // How strongly the IBL environment contributes (0 disables reflections).
    env_intensity?: number
    // Camera-relative key-light offset (right, up, toward-camera), scaled by the
    // camera distance each frame.
    offset?: [number, number, number]
  }
  let {
    directional = 0.3,
    ambient = 0.7,
    env_intensity = 0.3,
    offset = [0.32, 0.22, 0.6],
  }: Props = $props()

  const threlte = useThrelte()

  let light: DirectionalLight | undefined = $state()
  const scratch_offset = new Vector3()
  const MIN_LIGHT_DISTANCE = 4

  useTask(() => {
    const cam = threlte.camera.current
    const l = light
    if (!cam || !l) return
    const distance = Math.max(cam.position.length(), MIN_LIGHT_DISTANCE)
    scratch_offset
      .set(offset[0], offset[1], offset[2])
      .multiplyScalar(distance)
      .applyQuaternion(cam.quaternion)
    l.position.copy(cam.position).add(scratch_offset)
    l.target.position.set(0, 0, 0)
    l.target.updateMatrixWorld()
  })

  let env_texture: Texture | undefined
  $effect(() => {
    void env_intensity
    const renderer = threlte.renderer
    const scene = threlte.scene
    if (!renderer || !scene) return
    // IBL is a nice-to-have: baking RoomEnvironment through PMREM needs float
    // render-target support that some headless/software WebGL backends (CI's
    // SwiftShader) lack. Never let it throw — a failed bake must not take down
    // the whole scene; fall back to just the key + ambient lights.
    try {
      const pmrem = new PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      env_texture = pmrem.fromScene(room, 0.04).texture
      scene.environment = env_texture
      ;(scene as unknown as { environmentIntensity: number }).environmentIntensity =
        env_intensity
      pmrem.dispose()
      threlte.invalidate()
    } catch (err) {
      console.warn(`[SceneLighting] IBL environment unavailable; skipping`, err)
      env_texture = undefined
    }
    return () => {
      if (env_texture && scene.environment === env_texture) scene.environment = null
      env_texture?.dispose()
      env_texture = undefined
    }
  })
</script>

<T.AmbientLight intensity={ambient} />
<!-- Initial position is a sane fallback for the first paint before useTask runs;
     it is overwritten every frame to track the camera. -->
<T.DirectionalLight bind:ref={light} intensity={directional} position={[0, 5, 8]} />
