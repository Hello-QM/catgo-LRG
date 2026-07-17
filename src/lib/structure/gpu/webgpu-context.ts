/// <reference types="@webgpu/types" />
/** WebGPU device acquisition + capability detection. No rendering logic here. */

export function is_webgpu_supported(): boolean {
  return typeof navigator !== `undefined` && `gpu` in navigator && navigator.gpu != null
}

let _adapter_probe: Promise<boolean> | null = null

/** Real availability check: `is_webgpu_supported()` only confirms the API
 *  EXISTS (navigator.gpu); on many setups (e.g. AMD integrated + Linux without
 *  the Vulkan/WebGPU flags) `requestAdapter()` still returns null — API present
 *  but no device obtainable. This probes for an actual adapter once and caches
 *  the result, used to disable the large-system toggle when WebGPU can't really
 *  run instead of letting it fail at render time. */
export function probe_webgpu_available(): Promise<boolean> {
  if (_adapter_probe) return _adapter_probe
  _adapter_probe = (async () => {
    if (!is_webgpu_supported()) return false
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: `high-performance` })
      return adapter != null
    } catch {
      return false
    }
  })()
  return _adapter_probe
}

/** One leased GPUDevice (Bonds T6 device-loss transaction).
 *  - `generation` is monotonically increasing and NEVER reused, so a stale
 *    loss event can be matched against exactly the lease it belongs to.
 *  - `lost` is the device's loss promise (a never-resolving stand-in when a
 *    test fake carries none). Consumers subscribe ONCE per lease. */
export interface WebGpuLease {
  device: GPUDevice
  generation: number
  lost: Promise<GPUDeviceLostInfo>
}

let lease_counter = 0
let cached_lease: WebGpuLease | null = null
let lease_inflight: Promise<WebGpuLease | null> | null = null

/** Acquire the process-wide WebGPU device lease, or null when WebGPU is
 *  unavailable / acquisition fails. Concurrent callers share one acquisition;
 *  the lease is cached until its device is lost (auto-invalidated by the ONE
 *  loss subscription this module owns) or explicitly invalidated. */
export function get_webgpu_lease(): Promise<WebGpuLease | null> {
  if (cached_lease) return Promise.resolve(cached_lease)
  if (lease_inflight) return lease_inflight
  lease_inflight = (async () => {
    if (!is_webgpu_supported()) return null
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: `high-performance` })
      if (!adapter) return null
      // The spatial-grid bond compute pipeline binds 9 storage buffers; the default
      // maxStorageBuffersPerShaderStage is 8. Raise it to what the adapter supports
      // (capped at 16, plenty for 9). If an adapter reports < 9 (rare) the device
      // still gets the max it can — we'd need to merge buffers to fully support it.
      const want = Math.min(16, adapter.limits.maxStorageBuffersPerShaderStage)
      const device = await adapter.requestDevice({
        requiredLimits: { maxStorageBuffersPerShaderStage: want },
      })
      const generation = ++lease_counter
      // Test fakes may lack `lost`; treat those devices as never-lost.
      const lost = (device as { lost?: Promise<GPUDeviceLostInfo> }).lost ??
        new Promise<GPUDeviceLostInfo>(() => {})
      const lease: WebGpuLease = { device, generation, lost }
      // The ONE loss subscription this module owns: a lost device must never
      // be handed out again. Generation matching makes this transactional —
      // a stale loss can never clobber a newer lease (see invalidate below).
      void lost.then(() => invalidate_webgpu_lease(generation))
      cached_lease = lease
      return lease
    } catch {
      return null
    } finally {
      lease_inflight = null
    }
  })()
  return lease_inflight
}

/** Drop the cached lease IFF it is exactly `generation`. Any other value —
 *  older (a stale loss racing a fresh acquisition) or unknown — is a no-op, so
 *  only the lost device's own generation is ever invalidated. The next
 *  get_webgpu_lease() then acquires a fresh device with a higher generation. */
export function invalidate_webgpu_lease(generation: number): void {
  if (cached_lease?.generation === generation) cached_lease = null
}

/** Acquire a GPUDevice, or null if WebGPU is unavailable / acquisition fails.
 *  Back-compat accessor over get_webgpu_lease() — same cache, same device. */
export async function acquire_webgpu_device(): Promise<GPUDevice | null> {
  const lease = await get_webgpu_lease()
  return lease?.device ?? null
}

/** Test-only: reset the cached lease/device. Generations stay monotonic. */
export function __reset_device_cache(): void {
  cached_lease = null
  lease_inflight = null
}
