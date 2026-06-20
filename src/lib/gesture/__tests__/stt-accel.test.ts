import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  accel_status,
  accel_install,
  accel_download_model,
  accel_set_engine,
  poll_accel_progress,
} from '../stt-accel'

const okJson = (body: unknown) => ({ ok: true, json: async () => body })

afterEach(() => vi.unstubAllGlobals())

describe('stt-accel client', () => {
  it('accel_status parses the payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      platform_key: 'linux-x64-vulkan', gpu_api: 'vulkan', gpu_name: 'AMD',
      engine: 'faster-whisper', binary_installed: false, models_installed: [],
      download: { active: false, kind: null, pct: 0, error: null },
    })))
    const s = await accel_status()
    expect(s?.gpu_api).toBe('vulkan')
    expect(s?.engine).toBe('faster-whisper')
  })

  it('accel_status returns null on error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused') }))
    expect(await accel_status()).toBeNull()
  })

  it('accel_install POSTs', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ started: true }) }))
    vi.stubGlobal('fetch', f)
    expect(await accel_install()).toBe(true)
    expect(f.mock.calls[0][0]).toContain('/stt/accel/install')
    expect(f.mock.calls[0][1].method).toBe('POST')
  })

  it('accel_download_model passes the size', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', f)
    await accel_download_model('small')
    expect(f.mock.calls[0][0]).toContain('size=small')
  })

  it('accel_set_engine sends the engine in the body', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', f)
    await accel_set_engine('whispercpp')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ engine: 'whispercpp' })
  })

  it('poll_accel_progress loops until download inactive', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      platform_key: null, gpu_api: null, gpu_name: null, engine: 'whispercpp',
      binary_installed: true, models_installed: [],
      download: { active: n++ < 2, kind: 'binary', pct: n * 30, error: null },
    })))
    const ticks: number[] = []
    const final = await poll_accel_progress((s) => ticks.push(s.download.pct), 1)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(final?.download.active).toBe(false)
  })
})
