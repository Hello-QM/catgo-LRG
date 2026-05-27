interface Env { ALLOWED_HOSTS: string }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': `*`,
  'Access-Control-Allow-Methods': `GET,POST,OPTIONS`,
  'Access-Control-Allow-Headers': `Authorization,X-Api-Key,Content-Type,Accept`,
  'Access-Control-Max-Age': `86400`,
}
const FORWARD_HEADERS = [`authorization`, `x-api-key`, `content-type`, `accept`]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === `OPTIONS`) return new Response(null, { status: 204, headers: CORS_HEADERS })

    const target = new URL(request.url).searchParams.get(`url`)
    if (!target) return json({ error: `missing ?url=` }, 400)

    let targetUrl: URL
    try { targetUrl = new URL(target) } catch { return json({ error: `invalid url` }, 400) }

    const allowed = new Set(env.ALLOWED_HOSTS.split(`,`).map((h) => h.trim()).filter(Boolean))
    if (!allowed.has(targetUrl.host)) return json({ error: `host not allowed: ${targetUrl.host}` }, 403)

    const headers = new Headers()
    for (const h of FORWARD_HEADERS) {
      const v = request.headers.get(h)
      if (v) headers.set(h, v)
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === `POST` ? await request.text() : undefined,
    })

    const out = new Headers(upstream.headers)
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v)
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': `application/json`, ...CORS_HEADERS } })
}
