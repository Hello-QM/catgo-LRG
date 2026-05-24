<script lang="ts">
  import { Color, type Camera } from 'three'
  import type { AnyStructure, ElementSymbol } from '$lib/structure'
  import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
  import { pack_camera_full } from '$lib/structure/gpu/camera-uniform'
  import { pack_positions } from '$lib/structure/gpu/frame-buffers'
  import { build_atom_radii } from '$lib/structure/gpu/radius-lut'
  import {
    create_large_system_renderer,
    type LargeSystemRenderer,
  } from '$lib/structure/gpu/large-system-renderer'

  let {
    enabled = false,
    camera = undefined,
    structure = undefined,
    element_colors = undefined,
    on_fallback = undefined,
  }: {
    enabled?: boolean
    camera?: Camera | undefined
    /** Current displayed structure whose atoms render as impostor spheres. */
    structure?: AnyStructure | undefined
    /** Per-element hex colors (e.g. state colors.element). */
    element_colors?: Partial<Record<ElementSymbol, string>> | undefined
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
  // Set when buffers were rebuilt and must be re-uploaded to the GPU.
  let atoms_dirty = false

  // Hex -> linear RGB, matching the WebGL path (Color.convertSRGBToLinear).
  const _col = new Color()
  function hex_to_linear_rgb(hex: string): [number, number, number] {
    _col.set(hex).convertSRGBToLinear()
    return [_col.r, _col.g, _col.b]
  }

  /** Rebuild the flat atom buffers from the current structure + element colors.
   *  No-op (reuses cached arrays) when neither identity has changed. */
  function rebuild_atoms_if_needed(): void {
    if (structure === atom_source && element_colors === atom_colors_source) return
    atom_source = structure
    atom_colors_source = element_colors
    atoms_dirty = true
    const sites = structure?.sites
    // TODO(9.2-debug) remove
    console.log(
      `[lsr] rebuild atoms, sites=`, sites?.length ?? 0,
      `structure?`, structure != null,
      `element_colors?`, element_colors != null,
    )
    if (!sites || sites.length === 0) {
      atom_positions = new Float32Array(0)
      atom_radii = new Float32Array(0)
      atom_colors = new Float32Array(0)
      atom_count = 0
      return
    }
    atom_positions = pack_positions(sites)
    atom_radii = build_atom_radii(sites)
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

  function size_to_client(el: HTMLCanvasElement): void {
    const dpr = typeof window !== `undefined` ? window.devicePixelRatio || 1 : 1
    const w = el.clientWidth * dpr
    const h = el.clientHeight * dpr
    renderer?.resize(w, h)
  }

  async function start_session(el: HTMLCanvasElement): Promise<void> {
    const token = ++session_token
    // Fresh renderer => fresh GPU buffers. Force a rebuild + re-upload on the
    // first frame even if the structure identity hasn't changed since last time.
    atom_source = undefined
    atom_colors_source = undefined
    atoms_dirty = true
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
      // Rebuild atom buffers only when the structure / colors identity changed;
      // re-upload to the GPU only on that same change (static frame otherwise).
      rebuild_atoms_if_needed()
      if (atoms_dirty) {
        renderer.set_atoms(atom_positions, atom_radii, atom_colors, atom_count)
        atoms_dirty = false
      }
      if (camera) {
        camera.updateMatrixWorld()
        renderer.set_camera_full(pack_camera_full(camera))
      }
      renderer.render()
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
