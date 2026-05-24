<script lang="ts">
  import type { Camera } from 'three'
  import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
  import { pack_camera_uniform } from '$lib/structure/gpu/camera-uniform'
  import {
    create_large_system_renderer,
    type LargeSystemRenderer,
  } from '$lib/structure/gpu/large-system-renderer'

  let {
    enabled = false,
    camera = undefined,
    on_fallback = undefined,
  }: {
    enabled?: boolean
    camera?: Camera | undefined
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
      if (camera) {
        camera.updateMatrixWorld()
        renderer.set_camera(pack_camera_uniform(camera))
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
