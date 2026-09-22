// Run after pnpm build:wasm: node --test tests/browser/cube-worker.test.mjs
// Real production Vite inline Workers and scalar WASM, without COOP/COEP.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cube = `orbital\nfixture\n-1 0 0 0\n2 1 0 0\n1 0 1 0\n1 0 0 1\n1 0 1 0 0\n1 7\n0.125 0.25\n`
let directory, server, browser, url
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'catgo-cube-browser-'))
  await build({
    configFile: false, root, publicDir: false, logLevel: 'warn',
    resolve: { alias: { '$lib': join(root, 'src/lib'), '$app/environment': join(root, 'src/lib/mocks/environment.ts') } },
    plugins: [{
      name: 'resolve-ferrox-test-assets',
      // The desktop/embedding build supplies these URLs. Let Vite emit real
      // WASM assets here; no Rust function, parser, or Worker is mocked.
      transform(code, id) {
        if (id.endsWith('/ferrox-wasm.ts')) return code.replace(/\/\*\s*@vite-ignore\s*\*\/\s*(`@catgo\/ferrox-wasm\/[^`]+`)/gu, '$1')
      },
    }],
    worker: { format: 'es' },
    build: {
      outDir: directory, emptyOutDir: true, target: 'esnext',
      rollupOptions: { input: join(root, 'tests/browser/cube-worker-entry.ts'), preserveEntrySignatures: 'strict', output: { entryFileNames: 'client.js' } },
    },
  })
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Cube worker test</title>'); return }
    try {
      const body = await readFile(join(directory, pathname))
      response.setHeader('Content-Type', extname(pathname) === '.wasm' ? 'application/wasm' : 'application/javascript')
      response.end(body)
    } catch { response.statusCode = 404; response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
}, { timeout: 120_000 })
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function with_page(run) {
  const page = await browser.newPage()
  try { await page.goto(url); return await run(page) } finally { await page.close() }
}

test('real scalar Worker parses orbital geometry and rejects unsupported datasets', () => with_page(async page => {
  const result = await page.evaluate(async cube => {
    const { CubeClient } = await import('/client.js')
    const client = new CubeClient()
    try {
      const parsed = await client.parse(cube)
      const mesh = await client.extract(parsed.grid, 0.2, true)
      let error
      try { await client.parse(cube.replace('-1 0 0 0', '1 0 0 0 2')) } catch (failure) { error = failure.message }
      // A rejected input must not poison the persistent worker.
      const again = await client.parse(cube)
      return { isolated: crossOriginIsolated, backend: parsed.backend, x: parsed.header.atoms[0].position[0], data: [...parsed.grid.data], empty: mesh.positive === null && mesh.negative === null, error, again: again.backend }
    } finally { client.dispose() }
  }, cube)
  assert.equal(result.isolated, false)
  assert.equal(result.backend, 'rust')
  assert.ok(Math.abs(result.x - 0.529177210903) < 1e-12)
  assert.deepEqual(result.data, [0.125, 0.25])
  assert.equal(result.empty, true)
  assert.match(result.error, /multiple|dataset|NVAL/iu)
  assert.equal(result.again, 'rust')
}))

test('real Rust extraction handles dual planes and rotated/skewed axes with finite Cartesian face normals', () => with_page(async page => {
  const results = await page.evaluate(async () => {
    const { CubeClient, reference_extract } = await import('/client.js')
    const client = new CubeClient()
    const data = Float32Array.from({ length: 125 }, (_, i) => Math.floor(i / 25) - 2)
    const grids = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
      [[1, 0.2, 0], [0.5, 1, 0.3], [0, 0.1, 1]],
    ]
    const results = []
    try {
      for (const axes of grids) {
        const grid = { dims: [5, 5, 5], origin: [1, 2, 3], voxel_axes: axes, data, data_min: -2, data_max: 2 }
        for (const iso of [0.5, 1.25]) {
          const result = await client.extract(grid, iso, true)
          const expected = reference_extract(grid, iso)
          const cross = [axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1], axes[1][2] * axes[2][0] - axes[1][0] * axes[2][2], axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]]
          const unit = cross.map(value => value / Math.hypot(...cross))
          for (const [mesh, level] of [[result.positive, iso], [result.negative, -iso]]) {
            const anchor = grid.origin.map((value, i) => value + (level + 2) * axes[0][i])
            let error = 0, normal_dot = 1
            for (let i = 0; i < mesh.positions.length; i += 3) {
              error = Math.max(error, Math.abs(unit.reduce((sum, value, j) => sum + value * (mesh.positions[i + j] - anchor[j]), 0)))
              normal_dot = Math.min(normal_dot, unit.reduce((sum, value, j) => sum + value * mesh.normals[i + j], 0))
            }
            results.push({ backend: result.backend, vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, finite: [...mesh.positions, ...mesh.normals].every(Number.isFinite), valid_indices: [...mesh.indices].every(index => index < mesh.positions.length / 3), error, normal_dot, reference_dot: unit.reduce((sum, value, j) => sum + value * expected.normals[j], 0), bytes: data.byteLength })
          }
        }
      }
      return results
    } finally { client.dispose() }
  })
  assert.equal(results.length, 12)
  for (const result of results) {
    assert.equal(result.backend, 'rust')
    assert.ok(result.vertices > 0 && result.triangles > 0)
    assert.ok(result.finite && result.valid_indices)
    assert.ok(result.error < 1e-5, JSON.stringify(result))
    assert.ok(result.normal_dot > 0.999, JSON.stringify(result))
    assert.ok(result.reference_dot > 0.999, JSON.stringify(result))
    assert.equal(result.bytes, 500)
  }
}))

test('a failed WASM fetch uses the real TypeScript worker for parsing and extraction', () => with_page(async page => {
  await page.route('**/*.wasm', route => route.abort())
  const warnings = []
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
  const result = await page.evaluate(async cube => {
    const { CubeClient } = await import('/client.js')
    const client = new CubeClient()
    try {
      const parsed = await client.parse(cube)
      const grid = { dims: [3, 3, 3], origin: [0, 0, 0], voxel_axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], data: Float32Array.from({ length: 27 }, (_, i) => Math.floor(i / 9) - 1), data_min: -1, data_max: 1 }
      const mesh = await client.extract(grid, 0.5, true)
      return { parser: parsed.backend, extractor: mesh.backend, data: [...parsed.grid.data], positive: mesh.positive.positions.length, negative: mesh.negative.positions.length, bytes: grid.data.byteLength }
    } finally { client.dispose() }
  }, cube)
  assert.equal(result.parser, 'typescript')
  assert.equal(result.extractor, 'typescript')
  assert.deepEqual(result.data, [0.125, 0.25])
  assert.ok(result.positive > 0 && result.negative > 0)
  assert.equal(result.bytes, 108)
  assert.ok(warnings.includes('Rust/WASM parser unavailable; using TypeScript worker'))
  assert.ok(warnings.includes('Rust/WASM extractor unavailable; using TypeScript worker'))
}))
