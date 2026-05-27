import { describe, it, expect, vi } from `vitest`
import worker from '../src/index'

const env = { ALLOWED_HOSTS: `optimade.materialsproject.org` }

describe(`cors-relay worker`, () => {
  it(`answers preflight with ACAO:*`, async () => {
    const res = await worker.fetch(new Request(`https://relay/?url=x`, { method: `OPTIONS` }), env as never)
    expect(res.headers.get(`access-control-allow-origin`)).toBe(`*`)
  })

  it(`rejects non-allowlisted hosts`, async () => {
    const res = await worker.fetch(new Request(`https://relay/?url=` + encodeURIComponent(`https://evil.example.com/x`)), env as never)
    expect(res.status).toBe(403)
  })

  it(`forwards allowlisted host and adds ACAO`, async () => {
    const spy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(new Response(`{"data":[]}`, { status: 200 }))
    const target = `https://optimade.materialsproject.org/v1/structures`
    const res = await worker.fetch(new Request(`https://relay/?url=` + encodeURIComponent(target)), env as never)
    expect(res.status).toBe(200)
    expect(res.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(spy.mock.calls[0][0]).toBe(target)
    spy.mockRestore()
  })
})
