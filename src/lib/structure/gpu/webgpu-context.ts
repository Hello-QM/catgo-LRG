/// <reference types="@webgpu/types" />
/** WebGPU device acquisition + capability detection. No rendering logic here. */

export function is_webgpu_supported(): boolean {
  return typeof navigator !== `undefined` && `gpu` in navigator && navigator.gpu != null
}

let cached_device: GPUDevice | null = null

/** Acquire a GPUDevice, or null if WebGPU is unavailable / acquisition fails.
 *  Result is cached for the process lifetime. */
export async function acquire_webgpu_device(): Promise<GPUDevice | null> {
  if (cached_device !== null) return cached_device
  if (!is_webgpu_supported()) return null
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: `high-performance` })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    cached_device = device
    return device
  } catch {
    return null
  }
}

/** Test-only: reset the cached device. */
export function __reset_device_cache(): void { cached_device = null }
