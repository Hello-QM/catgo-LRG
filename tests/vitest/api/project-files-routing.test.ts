import { beforeEach, describe, expect, test, vi } from 'vitest'

const backend_available = vi.fn().mockResolvedValue(true)
const wasm_read = vi.fn()

vi.mock(`$lib/io/tauri`, () => ({ check_tauri: () => false }))
vi.mock(`$lib/api/config`, () => ({
  API_BASE: `/api`,
  desktop_backend_available: (...args: unknown[]) => backend_available(...args),
}))
vi.mock(`$lib/api/db-wasm`, () => ({
  db_read_file: (...args: unknown[]) => wasm_read(...args),
}))

import { read_file } from '$lib/api/project'

describe(`backend-served local filesystem routing`, () => {
  beforeEach(() => {
    backend_available.mockClear()
    wasm_read.mockClear()
    vi.stubGlobal(`fetch`, vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: `/tmp/sample.xyz`,
      name: `sample.xyz`,
      content: `1\nframe\nH 0 0 0\n`,
    }), {
      status: 200,
      headers: { 'Content-Type': `application/json` },
    })))
  })

  test(`uses the FastAPI file endpoint instead of Vite-only /__files/read`, async () => {
    const result = await read_file(`/tmp/sample.xyz`)

    expect(result.name).toBe(`sample.xyz`)
    expect(fetch).toHaveBeenCalledWith(
      `/api/workflow/files/read?path=%2Ftmp%2Fsample.xyz`,
    )
    expect(wasm_read).not.toHaveBeenCalled()
  })
})
