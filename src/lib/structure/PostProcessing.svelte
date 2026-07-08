<script lang="ts">
  // Screen-space post-processing for the 3D viewer, built on three's own
  // EffectComposer (no extra dependency):
  //   • GTAO (ground-truth ambient occlusion) darkens the crevices between
  //     densely packed atoms — the depth cue flat lighting cannot fake. This is
  //     the leapfrog effect figure-first viewers like pretty-lattice do NOT have.
  //   • Bokeh depth-of-field (opt-in) for presentation / hero renders.
  //
  // This component is only mounted while post-processing is active (the parent
  // gates it on the setting AND !large_system_mode / !trajectory playback). When
  // mounted, the <Canvas> autoRender is turned off by the parent so the composer
  // is the sole renderer; a task on Threlte's renderStage drives composer.render
  // on each (on-demand) frame. Unmounting restores Threlte's normal render path.
  import { useTask, useThrelte } from '@threlte/core'
  import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
  import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
  import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
  import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
  import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

  interface Props {
    // Enable GTAO ambient occlusion.
    ao?: boolean
    // Enable bokeh depth-of-field (requires the composer, so ao || dof mounts it).
    dof?: boolean
    // GTAO strength (0..1-ish blend over the beauty pass).
    ao_intensity?: number
  }
  let { ao = true, dof = false, ao_intensity = 1.0 }: Props = $props()

  const threlte = useThrelte()

  let composer: EffectComposer | undefined
  let gtao_pass: GTAOPass | undefined
  let bokeh_pass: BokehPass | undefined

  function viewport_size(): [number, number] {
    const el = threlte.renderer?.domElement
    const w = threlte.size.current?.width || el?.clientWidth || 1
    const h = threlte.size.current?.height || el?.clientHeight || 1
    return [Math.max(1, w), Math.max(1, h)]
  }

  // (Re)build the composer whenever the renderer/scene/camera or the enabled
  // passes change. Tracked deps: camera.current, size.current, ao, dof.
  $effect(() => {
    const renderer = threlte.renderer
    const scene = threlte.scene
    const camera = threlte.camera.current
    const [width, height] = viewport_size()
    void ao
    void dof
    void ao_intensity
    if (!renderer || !scene || !camera) return

    const next = new EffectComposer(renderer)
    next.setPixelRatio(renderer.getPixelRatio())
    next.setSize(width, height)
    next.addPass(new RenderPass(scene, camera))

    if (ao) {
      const gtao = new GTAOPass(scene, camera, width, height)
      gtao.output = GTAOPass.OUTPUT.Default
      gtao.blendIntensity = ao_intensity
      // Radius/scale tuned for Ångström-scale atomic geometry; keep the AO local
      // to contact points rather than smearing across the whole structure.
      gtao.updateGtaoMaterial({ radius: 2.0, distanceExponent: 1, scale: 1 })
      next.addPass(gtao)
      gtao_pass = gtao
    }

    if (dof) {
      const bokeh = new BokehPass(scene, camera, {
        focus: 40,
        aperture: 0.00025,
        maxblur: 0.01,
      })
      next.addPass(bokeh)
      bokeh_pass = bokeh
    }

    // OutputPass must be last: it applies the renderer's tone mapping (ACES) and
    // sRGB conversion that Threlte would otherwise do on a direct render.
    next.addPass(new OutputPass())

    composer = next
    threlte.invalidate()

    return () => {
      next.dispose()
      composer = undefined
      gtao_pass = undefined
      bokeh_pass = undefined
    }
  })

  // Keep composer sized to the canvas.
  $effect(() => {
    const [width, height] = viewport_size()
    if (!composer) return
    composer.setSize(width, height)
    gtao_pass?.setSize(width, height)
    bokeh_pass?.setSize(width, height)
    threlte.invalidate()
  })

  // Drive the composer on the render stage. autoInvalidate:false so it doesn't
  // force continuous rendering — it renders on the frames Threlte schedules
  // (on-demand invalidations from camera/scene changes).
  useTask(
    (delta) => {
      const c = composer
      const camera = threlte.camera.current
      if (!c || !camera) return
      c.render(delta)
    },
    { stage: threlte.renderStage, autoInvalidate: false },
  )
</script>
