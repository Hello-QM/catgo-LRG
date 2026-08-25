import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseSidecarChecksum,
  verifyVscodeSidecars,
  VSCODE_SIDECAR_ASSETS,
} from '../verify-vscode-sidecar-availability.mjs'

const DIGEST = '0123456789abcdef'.repeat(4)

test('accepts all three version-coupled sidecars and exact checksums', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push([url, options.method ?? 'GET'])
    const asset = VSCODE_SIDECAR_ASSETS.find((candidate) => url.includes(candidate))
    assert.ok(asset)
    if (url.endsWith('.sha256')) {
      return new Response(`${DIGEST}  ${asset}\n`, { status: 200 })
    }
    return new Response(null, {
      status: 200,
      headers: { 'content-length': '123456' },
    })
  }

  const result = await verifyVscodeSidecars({
    version: '1.4.11',
    fetchImpl,
  })

  assert.deepEqual(result.map(({ asset }) => asset), VSCODE_SIDECAR_ASSETS)
  assert.equal(requests.length, 6)
  assert.ok(requests.every(([url]) => url.includes('/v1.4.11/')))
})

test('fails closed before marketplace publication when a checksum is absent', async () => {
  const fetchImpl = async (url) => new Response(null, {
    status: url.endsWith('.sha256') ? 404 : 200,
  })

  await assert.rejects(
    verifyVscodeSidecars({ version: '1.4.21', fetchImpl }),
    /HTTP 404.*v1\.4\.21.*sha256/i,
  )
})

test('checksum metadata must name the exact platform asset', () => {
  assert.throws(
    () => parseSidecarChecksum(`${DIGEST}  another-binary\n`, 'catgo-server-linux-x64'),
    /malformed checksum metadata/i,
  )
})

test('rejects insecure sidecar origins', async () => {
  await assert.rejects(
    verifyVscodeSidecars({
      version: '1.4.11',
      baseUrl: 'http://dl.catgo-ucsd.org',
      fetchImpl: async () => new Response(null, { status: 200 }),
    }),
    /credential-free HTTPS/i,
  )
})
