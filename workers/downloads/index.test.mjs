import assert from 'node:assert/strict'
import test from 'node:test'

import worker from './index.mjs'

function createObject({
  body = null,
  key = 'v1.4.6/CatGo.exe',
  size = 100,
  range,
  contentType = 'application/octet-stream',
} = {}) {
  return {
    body,
    key,
    size,
    range,
    etag: 'abc123',
    httpEtag: '"abc123"',
    uploaded: new Date('2026-07-24T12:00:00Z'),
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {},
    writeHttpMetadata(headers) {
      headers.set('content-type', contentType)
      headers.set('cache-control', 'public, max-age=31536000, immutable')
    },
  }
}

function createBucket({ getResult = null, headResult = null } = {}) {
  return {
    getCalls: [],
    headCalls: [],
    async get(key, options) {
      this.getCalls.push({ key, options })
      return typeof getResult === 'function'
        ? getResult(key, options)
        : getResult
    },
    async head(key) {
      this.headCalls.push({ key })
      return typeof headResult === 'function' ? headResult(key) : headResult
    },
  }
}

function fetchDownload(bucket, path = '/', init) {
  return worker.fetch(
    new Request(`https://dl.catgo-ucsd.org${path}`, init),
    { RELEASES: bucket },
  )
}

test('maps the domain root to index.html and streams the original body', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<h1>CatGo</h1>'))
      controller.close()
    },
  })
  const bucket = createBucket({
    getResult: createObject({
      body,
      key: 'index.html',
      size: 14,
      contentType: 'text/html; charset=utf-8',
    }),
  })

  const response = await fetchDownload(bucket)

  assert.equal(response.status, 200)
  assert.equal(bucket.getCalls[0].key, 'index.html')
  assert.equal(response.body, body)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('content-length'), '14')
  assert.equal(response.headers.get('etag'), '"abc123"')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-disposition'), 'inline')
})

test('uses R2 head for HEAD requests and never fetches the object body', async () => {
  const bucket = createBucket({
    headResult: createObject({
      key: 'latest.json',
      size: 9_765,
      contentType: 'application/json',
    }),
  })

  const response = await fetchDownload(bucket, '/latest.json', {
    method: 'HEAD',
  })

  assert.equal(response.status, 200)
  assert.equal(response.body, null)
  assert.deepEqual(bucket.headCalls, [{ key: 'latest.json' }])
  assert.equal(bucket.getCalls.length, 0)
  assert.equal(response.headers.get('content-length'), '9765')
  assert.equal(response.headers.get('content-disposition'), 'inline')
})

test('forwards byte ranges to R2 and emits resumable response metadata', async () => {
  const body = new ReadableStream()
  const bucket = createBucket({
    getResult: createObject({
      body,
      size: 100,
      range: { offset: 10, length: 5 },
    }),
  })

  const response = await fetchDownload(
    bucket,
    '/v1.4.6/CatGo_1.4.6_x64-setup.exe',
    { headers: { Range: 'bytes=10-14' } },
  )

  assert.equal(response.status, 206)
  assert.equal(bucket.getCalls[0].options.range.get('range'), 'bytes=10-14')
  assert.equal(response.headers.get('content-range'), 'bytes 10-14/100')
  assert.equal(response.headers.get('content-length'), '5')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.match(
    response.headers.get('content-disposition'),
    /^attachment; filename\*=UTF-8''CatGo_1\.4\.6_x64-setup\.exe$/,
  )
})

test('returns an empty 304 when an R2 conditional GET has no body', async () => {
  const bucket = createBucket({
    getResult: createObject({ body: undefined, key: 'latest.json' }),
  })

  const response = await fetchDownload(bucket, '/latest.json', {
    headers: { 'If-None-Match': '"abc123"' },
  })

  assert.equal(bucket.getCalls[0].options.onlyIf.get('if-none-match'), '"abc123"')
  assert.equal(response.status, 304)
  assert.equal(response.body, null)
  assert.equal(response.headers.get('etag'), '"abc123"')
})

test('returns an empty 412 for a failed positive precondition', async () => {
  const bucket = createBucket({
    getResult: createObject({ body: undefined }),
  })

  const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: { 'If-Match': '"different"' },
  })

  assert.equal(response.status, 412)
  assert.equal(response.body, null)
})

test('evaluates HEAD conditionals and ranges from object metadata', async () => {
  const bucket = createBucket({
    headResult: createObject({ key: 'v1.4.6/CatGo.exe', size: 100 }),
  })

  const notModified = await fetchDownload(
    bucket,
    '/v1.4.6/CatGo.exe',
    { method: 'HEAD', headers: { 'If-None-Match': '"abc123"' } },
  )
  const ranged = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    method: 'HEAD',
    headers: { Range: 'bytes=90-' },
  })

  assert.equal(notModified.status, 304)
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 90-99/100')
  assert.equal(ranged.headers.get('content-length'), '10')
})

test('returns bilingual 404 and method-aware 405 responses', async () => {
  const bucket = createBucket()

  const missing = await fetchDownload(bucket, '/missing.exe')
  const unsupported = await fetchDownload(bucket, '/index.html', {
    method: 'POST',
  })

  assert.equal(missing.status, 404)
  assert.match(await missing.text(), /未找到/)
  assert.equal(unsupported.status, 405)
  assert.equal(unsupported.headers.get('allow'), 'GET, HEAD')
  assert.match(await unsupported.text(), /不支持/)
  assert.equal(bucket.getCalls.length, 1)
})

test('rejects traversal, encoded separators, malformed escapes, and NULs', async () => {
  const bucket = createBucket()
  const paths = [
    '/v1.4.6/%252e%252e',
    '/v1.4.6%2Fsecret',
    '/v1.4.6/%5Csecret',
    '/v1.4.6/%00secret',
    '/v1.4.6/%ZZ',
  ]

  for (const path of paths) {
    const response = await fetchDownload(bucket, path)
    assert.equal(response.status, 400, path)
  }
  assert.equal(bucket.getCalls.length, 0)
  assert.equal(bucket.headCalls.length, 0)
})
