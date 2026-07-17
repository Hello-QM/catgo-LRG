/**
 * Default-view persistence (state/default-view.svelte.ts) — payload
 * validation, storage-failure resilience, and cross-window storage sync.
 *
 * The module holds module-level $state initialized from localStorage at
 * import time, so each test re-imports a fresh instance via resetModules.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DefaultView } from '$lib/structure/state/default-view.svelte'

const KEY = `catgo-default-view`

async function fresh_module() {
  vi.resetModules()
  return await import(`$lib/structure/state/default-view.svelte`)
}

const valid_view: DefaultView = { dir: [0.1, -0.9, 0.2], up: [0, 0, 1] }

// Temporarily replace the global localStorage binding (descriptor-level, so
// even property ACCESS can be made to throw like a cookie-blocked browser).
async function with_storage_descriptor<T>(
  descriptor: PropertyDescriptor,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, `localStorage`)
  Object.defineProperty(globalThis, `localStorage`, {
    configurable: true,
    ...descriptor,
  })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(globalThis, `localStorage`, original)
    else delete (globalThis as Record<string, unknown>).localStorage
  }
}

describe(`default-view state`, () => {
  it(`round-trips a valid {dir,up} through localStorage`, async () => {
    const mod = await fresh_module()
    expect(mod.get_default_view()).toBeNull()
    expect(mod.set_default_view(valid_view)).toBe(true)
    expect(mod.get_default_view()).toEqual(valid_view)
    expect(JSON.parse(localStorage.getItem(KEY) ?? ``)).toEqual(valid_view)
    // A fresh module instance (new window / next session) loads the same view
    const mod2 = await fresh_module()
    expect(mod2.get_default_view()).toEqual(valid_view)
    expect(mod2.load_default_view()).toEqual(valid_view)
  })

  it.each([
    [`malformed JSON`, `not-json{`],
    [`empty object`, `{}`],
    [`non-finite (null) element`, `{"dir":[null,0,1],"up":[0,0,1]}`],
    [`string elements`, `{"dir":["a","b","c"],"up":[0,0,1]}`],
    [`boolean elements`, `{"dir":[0,-1,0],"up":[true,true,true]}`],
    [`wrong arity`, `{"dir":[0,1],"up":[0,0,1]}`],
    [`zero-length dir`, `{"dir":[0,0,0],"up":[0,0,1]}`],
    [`zero-length up`, `{"dir":[0,-1,0],"up":[0,0,0]}`],
  ])(`rejects stored payload with %s`, async (_label, raw) => {
    const mod = await fresh_module()
    expect(mod.parse_default_view(raw)).toBeNull()
    localStorage.setItem(KEY, raw)
    expect(mod.load_default_view()).toBeNull()
    const mod2 = await fresh_module() // import with the bad payload present
    expect(mod2.get_default_view()).toBeNull()
  })

  it(`parse_default_view handles null/empty raw`, async () => {
    const mod = await fresh_module()
    expect(mod.parse_default_view(null)).toBeNull()
    expect(mod.parse_default_view(``)).toBeNull()
  })

  it(`refuses to persist degenerate zero-length vectors`, async () => {
    const mod = await fresh_module()
    expect(mod.set_default_view({ dir: [0, 0, 0], up: [0, 0, 1] })).toBe(false)
    expect(mod.set_default_view({ dir: [0, -1, 0], up: [0, 0, 0] })).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(mod.get_default_view()).toBeNull()
  })

  it(`clear_default_view removes the key and nulls the shared state`, async () => {
    const mod = await fresh_module()
    mod.set_default_view(valid_view)
    mod.clear_default_view()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(mod.get_default_view()).toBeNull()
  })

  it(`returns null instead of throwing when localStorage ACCESS throws`, async () => {
    await with_storage_descriptor({
      get() {
        throw new Error(`SecurityError: The document is sandboxed`)
      },
    }, async () => {
      // Module import runs load_default_view() in the $state initializer —
      // this is the web mount-crash path and must not throw.
      const mod = await fresh_module()
      expect(mod.get_default_view()).toBeNull()
      expect(mod.load_default_view()).toBeNull()
      // Writes still work in memory for this session
      expect(mod.set_default_view(valid_view)).toBe(true)
      expect(mod.get_default_view()).toEqual(valid_view)
      expect(() => mod.clear_default_view()).not.toThrow()
      expect(mod.get_default_view()).toBeNull()
    })
  })

  it(`keeps the in-memory view when setItem throws (private mode / quota)`, async () => {
    const throwing_storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error(`QuotaExceededError`)
      },
      removeItem: () => {
        throw new Error(`QuotaExceededError`)
      },
      clear: () => {},
    }
    await with_storage_descriptor(
      { value: throwing_storage, writable: true },
      async () => {
        const mod = await fresh_module()
        expect(mod.set_default_view(valid_view)).toBe(true)
        expect(mod.get_default_view()).toEqual(valid_view)
        expect(() => mod.clear_default_view()).not.toThrow()
        expect(mod.get_default_view()).toBeNull()
      },
    )
  })

  it(`syncs from other windows via the storage event`, async () => {
    const mod = await fresh_module()
    expect(mod.get_default_view()).toBeNull()
    const dispatch = (key: string | null, newValue: string | null) =>
      window.dispatchEvent(Object.assign(new Event(`storage`), { key, newValue }))
    // Another window saved a default view
    dispatch(KEY, JSON.stringify(valid_view))
    expect(mod.get_default_view()).toEqual(valid_view)
    // Unrelated key — ignored
    dispatch(`some-other-key`, `whatever`)
    expect(mod.get_default_view()).toEqual(valid_view)
    // Another window wrote a corrupt value — treated as absent, not a crash
    dispatch(KEY, `{"dir":[0,0,0],"up":[0,0,1]}`)
    expect(mod.get_default_view()).toBeNull()
    // localStorage.clear() in another window (key === null)
    dispatch(KEY, JSON.stringify(valid_view))
    dispatch(null, null)
    expect(mod.get_default_view()).toBeNull()
  })
})
