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
    headResult: createObject({ size: 100 }),
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
  assert.deepEqual(bucket.getCalls[0].options.range, {
    offset: 10,
    length: 5,
  })
  assert.equal(response.headers.get('content-range'), 'bytes 10-14/100')
  assert.equal(response.headers.get('content-length'), '5')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.match(
    response.headers.get('content-disposition'),
    /^attachment; filename\*=UTF-8''CatGo_1\.4\.6_x64-setup\.exe$/,
  )
})

test('uses R2 returned range metadata when the object shrinks after HEAD', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
    getResult: createObject({
      body: new ReadableStream(),
      size: 95,
      range: { offset: 90, length: 5 },
    }),
  })

  const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: { Range: 'bytes=90-' },
  })

  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 90-94/95')
  assert.equal(response.headers.get('content-length'), '5')
})

test('rejects partial bodies with missing or invalid R2 range metadata', async () => {
  for (const range of [undefined, { offset: 90, length: 0 }]) {
    let cancellations = 0
    const body = new ReadableStream({
      cancel() {
        cancellations += 1
      },
    })
    const bucket = createBucket({
      headResult: createObject({ size: 100 }),
      getResult: createObject({ body, size: 95, range }),
    })

    const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
      headers: { Range: 'bytes=90-' },
    })

    assert.deepEqual(bucket.getCalls[0].options.range, {
      offset: 90,
      length: 10,
    })
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('content-range'), null)
    assert.equal(cancellations, 1)
  }
})

test('returns a complete GET response when R2 reports a full-object range', async () => {
  const bucket = createBucket({
    getResult: createObject({
      body: new ReadableStream(),
      size: 100,
      range: { offset: 0, length: 100 },
    }),
  })

  const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-range'), null)
  assert.equal(response.headers.get('content-length'), '100')
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

test('evaluates HEAD conditionals and ignores Range as required by HTTP', async () => {
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
  assert.equal(ranged.status, 200)
  assert.equal(ranged.headers.get('content-range'), null)
  assert.equal(ranged.headers.get('content-length'), '100')
})

test('normalizes suffix and open-ended GET ranges before calling R2', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
    getResult: createObject({
      body: new ReadableStream(),
      size: 100,
      range: { offset: 90, length: 10 },
    }),
  })

  await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: { Range: 'bytes=-10' },
  })
  await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: { Range: 'bytes=90-' },
  })

  assert.deepEqual(
    bucket.getCalls.map(({ options }) => options.range),
    [
      { offset: 90, length: 10 },
      { offset: 90, length: 10 },
    ],
  )
})

test('honors Range only when If-Range strongly matches the current object', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
    getResult(_key, options) {
      return createObject({
        body: new ReadableStream(),
        size: 100,
        range: options.range,
      })
    },
  })

  const matching = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=10-14',
      'If-Range': '"abc123"',
    },
  })
  const stale = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=10-14',
      'If-Range': '"old-etag"',
    },
  })
  const weak = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=10-14',
      'If-Range': 'W/"abc123"',
    },
  })

  assert.equal(matching.status, 206)
  assert.deepEqual(bucket.getCalls[0].options.range, {
    offset: 10,
    length: 5,
  })
  assert.equal(stale.status, 200)
  assert.equal(bucket.getCalls[1].options.range, undefined)
  assert.equal(weak.status, 200)
  assert.equal(bucket.getCalls[2].options.range, undefined)
})

test('honors date If-Range only when the object has not changed', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
    getResult(_key, options) {
      return createObject({
        body: new ReadableStream(),
        size: 100,
        range: options.range,
      })
    },
  })

  const unchanged = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=90-',
      'If-Range': 'Thu, 24 Jul 2026 12:00:00 GMT',
    },
  })
  const changed = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=90-',
      'If-Range': 'Thu, 24 Jul 2026 11:59:59 GMT',
    },
  })
  const invalid = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      Range: 'bytes=90-',
      'If-Range': 'not-a-validator',
    },
  })

  assert.equal(unchanged.status, 206)
  assert.deepEqual(bucket.getCalls[0].options.range, {
    offset: 90,
    length: 10,
  })
  assert.equal(changed.status, 200)
  assert.equal(bucket.getCalls[1].options.range, undefined)
  assert.equal(invalid.status, 200)
  assert.equal(bucket.getCalls[2].options.range, undefined)
})

test('returns 416 before GET for malformed, multiple, or unsatisfiable ranges', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
  })
  const ranges = [
    'items=0-1',
    'bytes=',
    'bytes=10-2',
    'bytes=100-',
    'bytes=0-1,4-5',
  ]

  for (const range of ranges) {
    const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
      headers: { Range: range },
    })
    assert.equal(response.status, 416, range)
    assert.equal(response.headers.get('content-range'), 'bytes */100')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
  }
  assert.equal(bucket.getCalls.length, 0)
})

test('converts an R2 InvalidRange race into 416', async () => {
  const bucket = createBucket({
    headResult: createObject({ size: 100 }),
    getResult() {
      throw new Error('InvalidRange: object changed after HEAD')
    },
  })

  const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: { Range: 'bytes=90-' },
  })

  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), 'bytes */100')
})

test('honors positive conditional precedence for bodyless GET results', async () => {
  const bucket = createBucket({
    getResult: createObject({ body: undefined }),
  })

  const response = await fetchDownload(bucket, '/v1.4.6/CatGo.exe', {
    headers: {
      'If-Match': '"different"',
      'If-None-Match': '"abc123"',
    },
  })

  assert.equal(response.status, 412)
})

test('returns bilingual 404 and method-aware 405 responses', async () => {
  const bucket = createBucket()

  const missing = await fetchDownload(bucket, '/v1.4.6/missing.exe')
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

test('restricts requests to root metadata or one app-tag asset', async () => {
  const bucket = createBucket()
  const paths = [
    '/secret',
    '/v1.4.6/nested/secret',
    '/v1.4.6/../secret',
    '/v1.4.6/%2e%2e/secret',
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
