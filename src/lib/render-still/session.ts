/**
 * RenderStillSession — one offline, progressive path-traced still render.
 *
 * Owns a dedicated offscreen WebGLRenderer (the live viewer canvas is never
 * touched), a baked merge of the displayed structure (see bake.ts), and a
 * three-gpu-pathtracer WebGLPathTracer. The pathtracer blits its running
 * accumulation into `preview_canvas` after every sample, so the dialog can
 * simply insert that canvas for a free progressive preview. PNG export reads
 * the FLOAT accumulation target back and tone-maps on the CPU (tonemap.ts),
 * sidestepping the browser drawingBuffer size clamp.
 *
 * Lifecycle: construct → start() → (cancel()) → save_png() → dispose().
 * A session is single-use; render again = new session.
 */
import { download } from '$lib/io/fetch'
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { Camera, Texture } from 'three'
import { GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer'
import { CENTER } from 'three-mesh-bvh'
import { bake_atoms, bake_bonds } from './bake'
import type { BakedArrays, RenderStillSource, TemplateMesh } from './bake'

export type RenderStillStatus =
  | `idle`
  | `baking`
  | `building-bvh`
  | `sampling`
  | `done`
  | `cancelled`
  | `error`

export type SphereDetail = `standard` | `high`

/** Sphere tessellation per quality tier (spike-validated: 12×9 is visually
 *  clean at typical atom sizes; 16×12 for close-up hero shots). */
const SPHERE_SEGMENTS: Record<SphereDetail, [number, number]> = {
  standard: [12, 9],
  high: [16, 12],
}

export interface RenderStillOptions {
  width: number
  height: number
  /** target sample count (50–100 = draft/screen, ~500 = publication) */
  samples: number
  bounces: number
  sphere_detail: SphereDetail
  on_progress?: (samples: number, total: number) => void
  on_status?: (status: RenderStillStatus) => void
  on_error?: (message: string) => void
}

/** The backdoor StructureScene installs on the live viewer canvas. */
export interface RenderStillCanvas extends HTMLCanvasElement {
  __renderer?: WebGLRenderer
  __scene?: Scene
  __camera?: Camera
  __render_still_source?: () => RenderStillSource | null
}

function next_frame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === `function`) {
      requestAnimationFrame(() => resolve())
    } else setTimeout(resolve, 0)
  })
}

function template_from_geometry(geom: BufferGeometry): TemplateMesh {
  const tmpl: TemplateMesh = {
    position: new Float32Array(geom.attributes.position.array),
    normal: new Float32Array(geom.attributes.normal.array),
    index: new Uint32Array(geom.index?.array ?? []),
  }
  geom.dispose()
  return tmpl
}

function geometry_from_arrays(arrays: BakedArrays): BufferGeometry {
  const geom = new BufferGeometry()
  geom.setAttribute(`position`, new BufferAttribute(arrays.position, 3))
  geom.setAttribute(`normal`, new BufferAttribute(arrays.normal, 3))
  geom.setAttribute(`color`, new BufferAttribute(arrays.color, 3))
  geom.setIndex(new BufferAttribute(arrays.index, 1))
  return geom
}

export class RenderStillSession {
  readonly preview_canvas: HTMLCanvasElement

  #opts: RenderStillOptions
  #live_scene: Scene
  #live_camera: Camera
  #live_clear_color: Color
  #source: RenderStillSource

  #renderer: WebGLRenderer | null = null
  #path_tracer: WebGLPathTracer | null = null
  #scene: Scene | null = null
  #owned_disposables: { dispose: () => void }[] = []
  #status: RenderStillStatus = `idle`
  #raf = 0
  #disposed = false

  /**
   * Build a session from the live viewer canvas. Throws when the canvas is
   * missing the StructureScene backdoors or the structure snapshot is empty.
   */
  static from_canvas(
    canvas: HTMLCanvasElement,
    opts: RenderStillOptions,
  ): RenderStillSession {
    const live = canvas as RenderStillCanvas
    if (!live.__renderer || !live.__scene || !live.__camera) {
      throw new Error(`viewer canvas is missing the __renderer/__scene/__camera backdoor`)
    }
    if (!live.__render_still_source) {
      throw new Error(`viewer canvas is missing the __render_still_source backdoor`)
    }
    const source = live.__render_still_source()
    if (!source || source.site_count === 0) {
      throw new Error(`no displayed structure to render`)
    }
    const clear_color = new Color()
    live.__renderer.getClearColor(clear_color)
    return new RenderStillSession(opts, live.__scene, live.__camera, clear_color, source)
  }

  private constructor(
    opts: RenderStillOptions,
    live_scene: Scene,
    live_camera: Camera,
    live_clear_color: Color,
    source: RenderStillSource,
  ) {
    this.#opts = opts
    this.#live_scene = live_scene
    this.#live_camera = live_camera
    this.#live_clear_color = live_clear_color
    this.#source = source
    this.preview_canvas = document.createElement(`canvas`)
  }

  get status(): RenderStillStatus {
    return this.#status
  }

  get samples(): number {
    return this.#path_tracer ? Math.floor(this.#path_tracer.samples) : 0
  }

  #set_status(status: RenderStillStatus): void {
    this.#status = status
    this.#opts.on_status?.(status)
  }

  /** Bake, build the BVH, then sample progressively until target/cancel. */
  async start(): Promise<void> {
    if (this.#status !== `idle`) return
    try {
      this.#set_status(`baking`)
      await next_frame() // let the dialog paint the status before we block

      const { width, height, bounces } = this.#opts
      const renderer = new WebGLRenderer({
        canvas: this.preview_canvas,
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: false,
        powerPreference: `high-performance`,
      })
      this.#renderer = renderer
      renderer.setPixelRatio(1)
      renderer.setSize(width, height, false)
      renderer.toneMapping = ACESFilmicToneMapping

      this.#scene = this.#build_scene()
      const camera = this.#clone_camera(width / height)

      this.#set_status(`building-bvh`)
      await next_frame() // BVH build is synchronous — paint status first

      const path_tracer = new WebGLPathTracer(renderer)
      this.#path_tracer = path_tracer
      path_tracer.bounces = bounces
      path_tracer.filterGlossyFactor = 0.5
      path_tracer.renderScale = 1
      path_tracer.dynamicLowRes = false
      path_tracer.renderDelay = 0
      path_tracer.minSamples = 1
      path_tracer.fadeDuration = 0
      path_tracer.tiles.set(2, 2)
      // CENTER split + leaf size 8: ~7× faster BVH build than the SAH
      // default at a negligible per-sample cost (spike-measured).
      ;(path_tracer as unknown as {
        _generator: { bvhOptions: Record<string, unknown> }
      })._generator.bvhOptions = {
        strategy: CENTER,
        maxLeafSize: 8,
        indirect: true,
      }
      path_tracer.setScene(this.#scene, camera)
      if (this.#disposed) return // torn down while the sync BVH build ran

      this.#set_status(`sampling`)
      this.#sample_loop()
    } catch (err) {
      console.error(`[render-still] failed to start`, err)
      this.#set_status(`error`)
      this.#opts.on_error?.(err instanceof Error ? err.message : String(err))
    }
  }

  #sample_loop(): void {
    const target = Math.max(1, this.#opts.samples)
    const tick = (): void => {
      if (this.#disposed || this.#status !== `sampling`) return
      const path_tracer = this.#path_tracer
      if (!path_tracer) return
      path_tracer.renderSample()
      const samples = Math.floor(path_tracer.samples)
      this.#opts.on_progress?.(Math.min(samples, target), target)
      if (samples >= target) {
        this.#set_status(`done`)
        return
      }
      this.#raf = requestAnimationFrame(tick)
    }
    this.#raf = requestAnimationFrame(tick)
  }

  /** Stop sampling. The accumulated image stays available for save_png(). */
  cancel(): void {
    if (this.#status === `sampling` || this.#status === `baking` ||
      this.#status === `building-bvh`) {
      cancelAnimationFrame(this.#raf)
      this.#set_status(`cancelled`)
    }
  }

  /**
   * Read the float accumulation target, tone-map on the CPU, and download
   * as PNG. Callable any time after the first sample (including after
   * cancel). Returns the blob (or null when there is nothing to save).
   */
  async save_png(filename: string): Promise<Blob | null> {
    const path_tracer = this.#path_tracer
    const renderer = this.#renderer
    if (!path_tracer || !renderer || this.samples < 1) return null

    const { float_rgba_to_srgb_pixels } = await import(`./tonemap`)
    const target = path_tracer.target
    const { width, height } = target
    const buffer = new Float32Array(width * height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer)
    const pixels = float_rgba_to_srgb_pixels(
      buffer,
      width,
      height,
      renderer.toneMappingExposure,
    )

    const canvas = document.createElement(`canvas`)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext(`2d`)
    if (!ctx) return null
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, `image/png`)
    )
    if (blob) download(blob, filename, `image/png`)
    return blob
  }

  /** Tear down GL resources. Safe to call multiple times. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    cancelAnimationFrame(this.#raf)
    if (this.#status === `sampling`) this.#status = `cancelled`
    try {
      this.#path_tracer?.dispose()
    } catch {
      // three-gpu-pathtracer dispose can throw on a lost context — ignore
    }
    for (const item of this.#owned_disposables) item.dispose()
    this.#owned_disposables = []
    this.#scene = null
    if (this.#renderer) {
      this.#renderer.dispose()
      this.#renderer.forceContextLoss()
      this.#renderer = null
    }
    this.preview_canvas.remove()
  }

  // ─── scene assembly ───

  #build_scene(): Scene {
    const [seg_w, seg_h] = SPHERE_SEGMENTS[this.#opts.sphere_detail]
    const scene = new Scene()

    const sphere_tmpl = template_from_geometry(new SphereGeometry(1, seg_w, seg_h))
    const atom_arrays = bake_atoms(this.#source, sphere_tmpl)
    if (atom_arrays) {
      const geom = geometry_from_arrays(atom_arrays)
      const mat = new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.35,
        metalness: 0,
      })
      scene.add(new Mesh(geom, mat))
      this.#owned_disposables.push(geom, mat)
    }

    const cyl_tmpl = template_from_geometry(new CylinderGeometry(1, 1, 1, 12, 1, true))
    const bond_arrays = bake_bonds(this.#source, cyl_tmpl)
    if (bond_arrays) {
      const geom = geometry_from_arrays(bond_arrays)
      const mat = new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.45,
        metalness: 0,
      })
      scene.add(new Mesh(geom, mat))
      this.#owned_disposables.push(geom, mat)
    }

    // Environment: reuse the live viewer's equirect IBL when present (not
    // ours to dispose); otherwise a neutral gradient sky (ours).
    const live_env = this.#live_scene.environment as Texture | null
    if (live_env?.isTexture && live_env.mapping === EquirectangularReflectionMapping) {
      scene.environment = live_env
    } else {
      const env = new GradientEquirectTexture()
      env.topColor.set(0xcfd8e6)
      env.bottomColor.set(0x40464f)
      env.update()
      scene.environment = env
      this.#owned_disposables.push(env)
    }
    // Opaque background matching the viewer's theme clear color.
    scene.background = this.#live_clear_color.clone()

    // Key lights: mirror the live scene's directional lights (world-space
    // positions). Fall back to a camera headlight so the render can never
    // come out black.
    let n_lights = 0
    const world_pos = new Vector3()
    this.#live_scene.traverse((obj) => {
      const light = obj as DirectionalLight
      if (!light.isDirectionalLight || light.intensity <= 0) return
      const clone = new DirectionalLight(light.color, light.intensity)
      light.getWorldPosition(world_pos)
      clone.position.copy(world_pos)
      scene.add(clone)
      n_lights++
    })
    if (n_lights === 0) {
      const headlight = new DirectionalLight(0xffffff, 2)
      this.#live_camera.getWorldPosition(world_pos)
      headlight.position.copy(
        world_pos.lengthSq() > 1e-6 ? world_pos : new Vector3(60, -80, 120),
      )
      scene.add(headlight)
    }

    return scene
  }

  #clone_camera(aspect: number): PerspectiveCamera | OrthographicCamera {
    const live = this.#live_camera
    if ((live as PerspectiveCamera).isPerspectiveCamera) {
      const src = live as PerspectiveCamera
      const cam = new PerspectiveCamera(src.fov, aspect, src.near, src.far)
      src.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale)
      cam.updateMatrixWorld(true)
      return cam
    }
    const src = live as OrthographicCamera
    // Keep the vertical extent (and zoom); re-derive the horizontal extent
    // from the still's aspect so framing matches the viewer vertically.
    const half_h = (src.top - src.bottom) / 2
    const cam = new OrthographicCamera(
      -half_h * aspect,
      half_h * aspect,
      half_h,
      -half_h,
      src.near,
      src.far,
    )
    cam.zoom = src.zoom
    cam.updateProjectionMatrix()
    src.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale)
    cam.updateMatrixWorld(true)
    return cam
  }
}
