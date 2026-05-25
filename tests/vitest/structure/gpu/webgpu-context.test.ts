import { describe, it, expect, vi, afterEach } from 'vitest'
import { is_webgpu_supported, acquire_webgpu_device, __reset_device_cache } from '$lib/structure/gpu/webgpu-context'

afterEach(() => { vi.unstubAllGlobals(); __reset_device_cache() })

describe(`webgpu-context`, () => {
  it(`is_webgpu_supported reflects navigator.gpu presence`, () => {
    vi.stubGlobal(`navigator`, {})
    expect(is_webgpu_supported()).toBe(false)
    vi.stubGlobal(`navigator`, { gpu: {} })
    expect(is_webgpu_supported()).toBe(true)
  })
  it(`acquire_webgpu_device returns null when unsupported`, async () => {
    vi.stubGlobal(`navigator`, {})
    expect(await acquire_webgpu_device()).toBeNull()
  })
  it(`acquire_webgpu_device returns null when adapter unavailable`, async () => {
    vi.stubGlobal(`navigator`, { gpu: { requestAdapter: async () => null } })
    expect(await acquire_webgpu_device()).toBeNull()
  })
  it(`acquire_webgpu_device returns the device on success`, async () => {
    const fake_device = { label: `d` }
    vi.stubGlobal(`navigator`, { gpu: { requestAdapter: async () => ({ limits: { maxStorageBuffersPerShaderStage: 16 }, requestDevice: async () => fake_device }) } })
    expect(await acquire_webgpu_device()).toBe(fake_device)
  })
})
