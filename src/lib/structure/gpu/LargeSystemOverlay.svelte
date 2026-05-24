<script lang="ts">
  import { Color, type Camera } from 'three'
  import type { AnyStructure, ElementSymbol } from '$lib/structure'
  import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
  import { pack_camera_full } from '$lib/structure/gpu/camera-uniform'
  import { pack_positions } from '$lib/structure/gpu/frame-buffers'
  import { build_display_radii } from '$lib/structure/gpu/radius-lut'
  import {
    create_large_system_renderer,
    type LargeSystemRenderer,
  } from '$lib/structure/gpu/large-system-renderer'

  let {
    enabled = false,
    camera = undefined,
    structure = undefined,
    element_colors = undefined,
    atom_radius = 1.5,
    same_size_atoms = false,
    element_radius_overrides = undefined,
    site_radius_overrides = undefined,
    on_fallback = undefined,
  }: {
    enabled?: boolean
    camera?: Camera | undefined
    /** Current displayed structure whose atoms render as impostor spheres. */
    structure?: AnyStructure | undefined
    /** Per-element hex colors (e.g. state colors.element). */
    element_colors?: Partial<Record<ElementSymbol, string>> | undefined
    /** Global display-radius scale, mirrors the WebGL atom_radius prop. */
    atom_radius?: number
    /** Render all atoms at the same size (WebGL same_size_atoms). */
    same_size_atoms?: boolean
    /** Per-element radius overrides, mirrors the WebGL path. */
    element_radius_overrides?: Partial<Record<ElementSymbol, number>> | undefined
    /** Per-site radius overrides, mirrors the WebGL path. */
    site_radius_overrides?: Map<number, number> | undefined
    on_fallback?: (reason: string) => void
  } = $props()

  let canvas = $state<HTMLCanvasElement | undefined>(undefined)

  // Active session resources. Kept outside $state — they are imperative GPU
  // handles, not reactive view data, and we don't want effects to re-run on
  // mutation. A monotonically increasing token cancels stale async starts.
  let renderer: LargeSystemRenderer | null = null
  let raf_id = 0
  let resize_observer: ResizeObserver | null = null
  let session_token = 0

  // Cached atom buffers, rebuilt only when the structure identity changes (not
  // every frame). `atom_source` is the identity sentinel we last built from.
  let atom_source: AnyStructure | undefined = undefined
  let atom_positions: Float32Array = new Float32Array(0)
  let atom_radii: Float32Array = new Float32Array(0)
  let atom_colors: Float32Array = new Float32Array(0)
  let atom_count = 0
  // Track the colors-object identity too, so a color-scheme swap rebuilds.
  let atom_colors_source: Partial<Record<ElementSymbol, string>> | undefined = undefined
  // Signature of the radius-affecting inputs we last built from; when it
  // changes the display radii must be recomputed.
  let atom_radius_sig = ``
  // Set when buffers were rebuilt and must be re-uploaded to the GPU.
  let atoms_dirty = false

  // Hex -> linear RGB, matching the WebGL path (Color.convertSRGBToLinear).
  const _col = new Color()
  function hex_to_linear_rgb(hex: string): [number, number, number] {
    _col.set(hex).convertSRGBToLinear()
    return [_col.r, _col.g, _col.b]
  }

  /** Cheap signature of the radius-affecting inputs; changes when any of them
   *  do so the display radii get recomputed (identity for the override maps,
   *  size for the site map, values for the element map). */
  function radius_signature(): string {
    let sro = ``
    if (site_radius_overrides && site_radius_overrides.size > 0) {
      for (const [k, v] of site_radius_overrides) sro += `${k}=${v};`
    }
    let ero = ``
    if (element_radius_overrides) {
      for (const k of Object.keys(element_radius_overrides)) {
        ero += `${k}=${(element_radius_overrides as Record<string, number>)[k]};`
      }
    }
    return `${atom_radius}|${same_size_atoms}|${ero}|${sro}`
  }

  /** Rebuild the flat atom buffers from the current structure + element colors
   *  + display-radius inputs. No-op (reuses cached arrays) when nothing that
   *  affects them has changed. */
  function rebuild_atoms_if_needed(): void {
    const sig = radius_signature()
    if (
      structure === atom_source &&
      element_colors === atom_colors_source &&
      sig === atom_radius_sig
    ) {
      return
    }
    atom_source = structure
    atom_colors_source = element_colors
    atom_radius_sig = sig
    atoms_dirty = true
    const sites = structure?.sites
    if (!sites || sites.length === 0) {
      atom_positions = new Float32Array(0)
      atom_radii = new Float32Array(0)
      atom_colors = new Float32Array(0)
      atom_count = 0
      return
    }
    atom_positions = pack_positions(sites)
    // VISUAL sphere radius — matches the WebGL ball-and-stick display sizing
    // (atomic_radii[element] * atom_radius, with same_size / overrides). NOT
    // the covalent bond-cutoff radius (build_atom_radii) used by 9.3.
    atom_radii = build_display_radii(sites, {
      atom_radius,
      same_size_atoms,
      element_radius_overrides,
      site_radius_overrides,
    })
    atom_count = sites.length
    const cols = new Float32Array(sites.length * 3)
    for (let i = 0; i < sites.length; i++) {
      const elem = sites[i].species[0]?.element
      const hex = (elem != null ? element_colors?.[elem] : undefined) ?? `#ffffff`
      const [r, g, b] = hex_to_linear_rgb(hex)
      cols[i * 3] = r
      cols[i * 3 + 1] = g
      cols[i * 3 + 2] = b
    }
    atom_colors = cols
  }

  function stop_session(): void {
    session_token++ // invalidate any in-flight acquire_webgpu_device()
    if (raf_id) {
      cancelAnimationFrame(raf_id)
      raf_id = 0
    }
    resize_observer?.disconnect()
    resize_observer = null
    renderer?.destroy()
    renderer = null
  }

  // On-demand render state. We keep a RAF tick but only issue a GPU draw when
  // something changed since the last drawn frame: camera moved, atom buffers
  // re-uploaded, or a resize happened. Avoids continuous GPU load when idle.
  let last_camera_uniform: Float32Array | null = null
  let needs_render = true // force the first frame

  /** True if `next` differs from the last uploaded camera uniform (epsilon
   *  compare). Updates the cached copy when it returns true. */
  function camera_changed(next: Float32Array): boolean {
    const prev = last_camera_uniform
    if (!prev || prev.length !== next.length) {
      last_camera_uniform = next.slice()
      return true
    }
    for (let i = 0; i < next.length; i++) {
      if (Math.abs(prev[i] - next[i]) > 1e-6) {
        last_camera_uniform = next.slice()
        return true
      }
    }
    return false
  }

  function size_to_client(el: HTMLCanvasElement): void {
    const dpr = typeof window !== `undefined` ? window.devicePixelRatio || 1 : 1
    const w = el.clientWidth * dpr
    const h = el.clientHeight * dpr
    renderer?.resize(w, h)
    needs_render = true // resized backing store/depth must repaint
  }

  async function start_session(el: HTMLCanvasElement): Promise<void> {
    const token = ++session_token
    // Fresh renderer => fresh GPU buffers. Force a rebuild + re-upload on the
    // first frame even if the structure identity hasn't changed since last time.
    atom_source = undefined
    atom_colors_source = undefined
    atom_radius_sig = ``
    atoms_dirty = true
    // Fresh GPU camera buffer ⇒ force a first paint and a re-upload.
    last_camera_uniform = null
    needs_render = true
    const device = await acquire_webgpu_device()
    // Bail if disabled / unmounted / superseded while awaiting.
    if (token !== session_token) return
    if (!device) {
      on_fallback?.(`WebGPU unavailable — staying on the WebGL viewer.`)
      return
    }
    let r: LargeSystemRenderer
    try {
      r = create_large_system_renderer(device, el)
    } catch (err) {
      on_fallback?.(`WebGPU renderer init failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    renderer = r
    size_to_client(el)

    resize_observer = new ResizeObserver(() => {
      if (renderer && canvas) size_to_client(canvas)
    })
    resize_observer.observe(el)

    const frame = () => {
      if (token !== session_token || !renderer) return
      // Per-frame dirty check — only issue a GPU draw when something changed.
      // We still rAF every frame (cheap) but early-return before render() when
      // the scene is idle, so the GPU isn't redrawing a static frame forever.
      let dirty = needs_render
      needs_render = false

      // Rebuild atom buffers only when the structure / colors / radius inputs
      // changed; re-upload + mark dirty on that same change.
      rebuild_atoms_if_needed()
      if (atoms_dirty) {
        renderer.set_atoms(atom_positions, atom_radii, atom_colors, atom_count)
        atoms_dirty = false
        dirty = true
      }

      // Camera: pack always (cheap), upload + mark dirty only when it moved.
      if (camera) {
        camera.updateMatrixWorld()
        const packed = pack_camera_full(camera)
        if (camera_changed(packed)) {
          renderer.set_camera_full(packed)
          dirty = true
        }
      }

      if (dirty) renderer.render()
      raf_id = requestAnimationFrame(frame)
    }
    raf_id = requestAnimationFrame(frame)
  }

  $effect(() => {
    // Re-run only on enabled / canvas changes. `camera` is read inside the RAF
    // loop (not tracked here) so a camera swap doesn't restart the session.
    if (enabled && canvas) {
      start_session(canvas)
      return () => stop_session()
    }
    // disabled or no canvas yet: ensure nothing is running.
    stop_session()
    return undefined
  })
</script>

{#if enabled}
  <canvas
    bind:this={canvas}
    class="large-system-overlay"
    style="position: absolute; inset: 0; width: 100%; height: 100%;"
  ></canvas>
{/if}

<style>
  .large-system-overlay {
    display: block;
    pointer-events: none;
  }
</style>
