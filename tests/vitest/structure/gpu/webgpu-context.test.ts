import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  is_webgpu_supported,
  acquire_webgpu_device,
  get_webgpu_lease,
  invalidate_webgpu_lease,
  __reset_device_cache,
} from '$lib/structure/gpu/webgpu-context'

afterEach(() => { vi.unstubAllGlobals(); __reset_device_cache() })

/** Stub navigator.gpu with an adapter whose requestDevice defers to `make_device`. */
const stub_gpu = (make_device: () => object) => {
  vi.stubGlobal(`navigator`, {
    gpu: {
      requestAdapter: async () => ({
        limits: { maxStorageBuffersPerShaderStage: 16 },
        requestDevice: async () => make_device(),
      }),
    },
  })
}

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

describe(`get_webgpu_lease`, () => {
  it(`returns null when unsupported`, async () => {
    vi.stubGlobal(`navigator`, {})
    expect(await get_webgpu_lease()).toBeNull()
  })

  it(`caches one lease and shares its device with acquire_webgpu_device`, async () => {
    let made = 0
    stub_gpu(() => ({ label: `d${made++}` }))
    const lease = await get_webgpu_lease()
    expect(lease).not.toBeNull()
    expect(made).toBe(1)
    // Same lease object on repeat acquisition — no second requestDevice.
    expect(await get_webgpu_lease()).toBe(lease)
    expect(await acquire_webgpu_device()).toBe(lease?.device)
    expect(made).toBe(1)
    // A fake device without a `lost` promise still leases (never-lost).
    expect(lease?.lost).toBeInstanceOf(Promise)
    expect(typeof lease?.generation).toBe(`number`)
  })

  it(`invalidates only the lost device generation`, async () => {
    let made = 0
    const losers: ((info: { reason: string }) => void)[] = []
    stub_gpu(() => {
      made++
      return {
        label: `d${made}`,
        lost: new Promise((resolve) => losers.push(resolve as never)),
      }
    })
    const lease1 = await get_webgpu_lease()
    expect(lease1).not.toBeNull()
    if (!lease1) return
    expect(made).toBe(1)

    // A non-matching generation is a STALE invalidation: the live lease survives.
    invalidate_webgpu_lease(lease1.generation + 999)
    expect(await get_webgpu_lease()).toBe(lease1)
    expect(made).toBe(1)

    // The device reports loss ⇒ the module invalidates EXACTLY that generation:
    // the next lease is a fresh device with a strictly higher generation.
    losers[0]({ reason: `destroyed` })
    await Promise.resolve() // let the module's single lost-subscription run
    const lease2 = await get_webgpu_lease()
    expect(lease2).not.toBeNull()
    if (!lease2) return
    expect(lease2).not.toBe(lease1)
    expect(lease2.device).not.toBe(lease1.device)
    expect(lease2.generation).toBeGreaterThan(lease1.generation)
    expect(made).toBe(2)

    // A LATE invalidation for the already-lost generation must not clobber the
    // newer lease (stale loss racing a fresh acquisition).
    invalidate_webgpu_lease(lease1.generation)
    expect(await get_webgpu_lease()).toBe(lease2)
    expect(made).toBe(2)
  })

  it(`dedupes concurrent acquisitions into one lease`, async () => {
    let made = 0
    stub_gpu(() => ({ label: `d${made++}` }))
    const [a, b] = await Promise.all([get_webgpu_lease(), get_webgpu_lease()])
    expect(a).toBe(b)
    expect(made).toBe(1)
  })
})
