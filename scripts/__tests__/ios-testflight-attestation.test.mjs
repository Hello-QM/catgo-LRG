import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-ios-testflight-attestation.mjs')
const FIXTURES = resolve(
  ROOT,
  'scripts/__tests__/fixtures/ios-testflight-attestation',
)
const TAG = 'v1.4.6'
const COMMIT = 'a'.repeat(40)
const FILENAME = `catgo-ios-testflight-${TAG}.json`

function withAssets(fixture, callback, filename = FILENAME) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-ios-attestation-'))
  const assets = resolve(root, 'assets')
  mkdirSync(assets)
  if (fixture) cpSync(resolve(FIXTURES, fixture), resolve(assets, filename))
  try {
    return callback(assets)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function verify(assetsDir, options = {}) {
  return spawnSync(
    process.execPath,
    [
      VERIFIER,
      '--tag',
      options.tag ?? TAG,
      '--source-commit',
      options.commit ?? COMMIT,
      '--assets-dir',
      assetsDir,
    ],
    { encoding: 'utf8' },
  )
}

test('accepts the exact versioned TestFlight acceptance attestation', () => {
  withAssets('valid.json', (assets) => {
    const result = verify(assets)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /TestFlight upload accepted/)
    assert.match(result.stdout, /run 123456789/)
  })
})

test('fails closed when the exact versioned attestation is missing', () => {
  withAssets(undefined, (assets) => {
    const result = verify(assets)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing TestFlight attestation/i)
  })
})

test('rejects an attestation stored under any non-exact filename', () => {
  withAssets('valid.json', (assets) => {
    const result = verify(assets)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing TestFlight attestation/i)
  }, 'testflight.json')
})

test('rejects a TestFlight attestation for another source commit', () => {
  withAssets('wrong-commit.json', (assets) => {
    const result = verify(assets)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /source commit/i)
  })
})

test('rejects every TestFlight status other than accepted', () => {
  withAssets('rejected.json', (assets) => {
    const result = verify(assets)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /status/i)
  })
})

test('rejects a tag mismatch and an inexact schema', async (t) => {
  await t.test('tag mismatch', () => {
    withAssets('valid.json', (assets) => {
      const path = resolve(assets, FILENAME)
      const attestation = JSON.parse(readFileSync(path, 'utf8'))
      attestation.releaseTag = 'v1.4.7'
      writeFileSync(path, `${JSON.stringify(attestation)}\n`)
      const result = verify(assets)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /tag/i)
    })
  })

  await t.test('extra schema property', () => {
    withAssets('valid.json', (assets) => {
      const path = resolve(assets, FILENAME)
      const attestation = JSON.parse(readFileSync(path, 'utf8'))
      attestation.untrusted = true
      writeFileSync(path, `${JSON.stringify(attestation)}\n`)
      const result = verify(assets)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /schema/i)
    })
  })

  await t.test('numeric run id', () => {
    withAssets('valid.json', (assets) => {
      const path = resolve(assets, FILENAME)
      const attestation = JSON.parse(readFileSync(path, 'utf8'))
      attestation.githubRunId = 123456789
      writeFileSync(path, `${JSON.stringify(attestation)}\n`)
      const result = verify(assets)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /run id/i)
    })
  })
})
