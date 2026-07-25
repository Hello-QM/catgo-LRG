const ALLOWED_METHODS = 'GET, HEAD'
const INLINE_EXTENSIONS = new Set(['.html', '.json'])
const APP_TAG_PATTERN = /^v\d+\.\d+\.\d+$/
const CONDITIONAL_HEADERS = [
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
]

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function badRequest() {
  return textResponse('无效下载路径 / Invalid download path', 400)
}

function resolveObjectKey(requestUrl) {
  const rawPath = new URL(requestUrl).pathname
  if (rawPath === '/' || rawPath === '/index.html') return 'index.html'
  if (
    !rawPath.startsWith('/')
    || /%(?:00|2f|5c)/i.test(rawPath)
  ) {
    return null
  }

  const segments = rawPath.slice(1).split('/')
  const decoded = []
  for (const segment of segments) {
    if (!segment) return null
    let value
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      value === '.'
      || value === '..'
      || value.includes('/')
      || value.includes('\\')
      || value.includes('\0')
      || /%(?:00|2e|2f|5c)/i.test(value)
    ) {
      return null
    }
    decoded.push(value)
  }
  if (decoded.length === 1 && decoded[0] === 'latest.json') {
    return decoded[0]
  }
  if (
    decoded.length === 2
    && APP_TAG_PATTERN.test(decoded[0])
    && decoded[1] !== '.'
    && decoded[1] !== '..'
  ) {
    return decoded.join('/')
  }
  return null
}

function requestHasConditionals(headers) {
  return CONDITIONAL_HEADERS.some((name) => headers.has(name))
}

function stripWeakPrefix(etag) {
  return etag.trim().replace(/^W\//i, '')
}

function etagListMatches(value, etag, { weak = false } = {}) {
  if (!value) return false
  if (value.trim() === '*') return true
  const expected = weak ? stripWeakPrefix(etag) : etag.trim()
  return value.split(',').some((candidate) => {
    const current = weak
      ? stripWeakPrefix(candidate)
      : candidate.trim()
    return current === expected
  })
}

function validDate(value) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function ifRangeMatches(request, object) {
  const value = request.headers.get('if-range')
  if (!value) return true

  const validator = value.trim()
  if (validator.startsWith('"') || /^W\//i.test(validator)) {
    return !/^W\//i.test(validator) && validator === object.httpEtag.trim()
  }

  const ifRangeDate = validDate(validator)
  if (ifRangeDate === null || !(object.uploaded instanceof Date)) {
    return false
  }
  const uploaded = Math.floor(object.uploaded.getTime() / 1000) * 1000
  return uploaded <= ifRangeDate
}

function headPreconditionStatus(request, object) {
  const { headers } = request
  const etag = object.httpEtag
  const uploaded = object.uploaded instanceof Date
    ? Math.floor(object.uploaded.getTime() / 1000) * 1000
    : null

  const ifMatch = headers.get('if-match')
  if (ifMatch && !etagListMatches(ifMatch, etag)) return 412

  if (!ifMatch) {
    const ifUnmodifiedSince = validDate(headers.get('if-unmodified-since'))
    if (
      ifUnmodifiedSince !== null
      && uploaded !== null
      && uploaded > ifUnmodifiedSince
    ) {
      return 412
    }
  }

  const ifNoneMatch = headers.get('if-none-match')
  if (ifNoneMatch && etagListMatches(ifNoneMatch, etag, { weak: true })) {
    return 304
  }

  if (!ifNoneMatch) {
    const ifModifiedSince = validDate(headers.get('if-modified-since'))
    if (
      ifModifiedSince !== null
      && uploaded !== null
      && uploaded <= ifModifiedSince
    ) {
      return 304
    }
  }

  return null
}

function parseRangeHeader(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return { invalid: true }
  }

  let start
  let end
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { invalid: true }
    }
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start >= size
      || end < start
    ) {
      return { invalid: true }
    }
    end = Math.min(end, size - 1)
  }

  return {
    offset: start,
    length: end - start + 1,
  }
}

function extensionForKey(key) {
  const filename = key.split('/').at(-1) ?? key
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

function encodeDispositionFilename(filename) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function buildHeaders(object, key, range = null) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')

  if (range) {
    const end = range.offset + range.length - 1
    headers.set(
      'content-range',
      `bytes ${range.offset}-${end}/${object.size}`,
    )
    headers.set('content-length', String(range.length))
  } else {
    headers.set('content-length', String(object.size))
  }

  if (INLINE_EXTENSIONS.has(extensionForKey(key))) {
    headers.set('content-disposition', 'inline')
  } else {
    const filename = key.split('/').at(-1) ?? 'download'
    headers.set(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeDispositionFilename(filename)}`,
    )
  }

  return headers
}

function rangeNotSatisfiable(size) {
  return new Response(null, {
    status: 416,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes */${size}`,
    },
  })
}

async function serveHead(request, bucket, key) {
  const object = await bucket.head(key)
  if (object === null) {
    return textResponse('未找到 / Download not found', 404)
  }

  const preconditionStatus = headPreconditionStatus(request, object)
  if (preconditionStatus !== null) {
    return new Response(null, {
      status: preconditionStatus,
      headers: buildHeaders(object, key),
    })
  }

  return new Response(null, {
    status: 200,
    headers: buildHeaders(object, key),
  })
}

async function serveGet(request, bucket, key) {
  const options = {}
  let rangeMetadata = null
  if (request.headers.has('range')) {
    rangeMetadata = await bucket.head(key)
    if (rangeMetadata === null) {
      return textResponse('未找到 / Download not found', 404)
    }
    const range = parseRangeHeader(
      request.headers.get('range'),
      rangeMetadata.size,
    )
    if (range?.invalid) return rangeNotSatisfiable(rangeMetadata.size)
    if (ifRangeMatches(request, rangeMetadata)) {
      options.range = range
    }
  }
  if (requestHasConditionals(request.headers)) {
    options.onlyIf = request.headers
  }

  let object
  try {
    object = await bucket.get(key, options)
  } catch (error) {
    if (
      rangeMetadata
      && error instanceof Error
      && /(?:invalid|unsatisfiable).*range|range.*(?:invalid|unsatisfiable)/i.test(
        error.message,
      )
    ) {
      return rangeNotSatisfiable(rangeMetadata.size)
    }
    throw error
  }
  if (object === null) {
    return textResponse('未找到 / Download not found', 404)
  }

  if (!object.body) {
    const status = headPreconditionStatus(request, object) ?? 412
    return new Response(null, {
      status,
      headers: buildHeaders(object, key),
    })
  }

  const range = options.range ?? null
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: buildHeaders(object, key, range),
  })
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(
        '不支持此请求方法 / Method not allowed',
        405,
        { allow: ALLOWED_METHODS },
      )
    }

    const key = resolveObjectKey(request.url)
    if (key === null) return badRequest()

    if (request.method === 'HEAD') {
      return serveHead(request, env.RELEASES, key)
    }
    return serveGet(request, env.RELEASES, key)
  },
}
