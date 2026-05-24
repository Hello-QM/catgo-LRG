import { afterEach, describe, expect, it, vi } from 'vitest'
import { HandTracker } from '../hand-tracker'

// Install a fake navigator.mediaDevices for the duration of one test.
function set_media_devices(value: unknown): void {
  Object.defineProperty(globalThis.navigator, `mediaDevices`, {
    value,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  vi.useRealTimers()
  set_media_devices(undefined)
})

describe(`HandTracker.start pre-flight (freeze prevention)`, () => {
  it(`fails fast WITHOUT calling getUserMedia when no camera is present`, async () => {
    // This is the core regression guard: on a camera-less machine getUserMedia
    // can stall and freeze the whole app, so it must never be reached.
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {})) // would hang forever
    const enumerateDevices = vi.fn(async () => [
      { kind: `audioinput`, deviceId: `mic`, label: ``, groupId: `` } as MediaDeviceInfo,
    ])
    set_media_devices({ getUserMedia, enumerateDevices })

    const tracker = new HandTracker()
    await expect(tracker.start(() => {})).rejects.toThrow(/No camera found/)
    expect(enumerateDevices).toHaveBeenCalledOnce()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(tracker.is_running).toBe(false)
  })

  it(`throws a clear message when the camera API is unavailable`, async () => {
    set_media_devices({}) // no getUserMedia
    const tracker = new HandTracker()
    await expect(tracker.start(() => {})).rejects.toThrow(/does not support camera access|desktop app/)
    expect(tracker.is_running).toBe(false)
  })

  it(`times out instead of hanging when getUserMedia never resolves`, async () => {
    vi.useFakeTimers()
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {})) // never settles
    const enumerateDevices = vi.fn(async () => [
      { kind: `videoinput`, deviceId: `cam`, label: ``, groupId: `` } as MediaDeviceInfo,
    ])
    set_media_devices({ getUserMedia, enumerateDevices })

    const tracker = new HandTracker()
    const started = tracker.start(() => {})
    const assertion = expect(started).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
    expect(getUserMedia).toHaveBeenCalledOnce()
  })
})
