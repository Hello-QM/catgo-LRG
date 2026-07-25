import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-macos-signing-attestation.mjs')
const TAG = 'v1.4.6'
const VERSION = TAG.slice(1)
const SOURCE_COMMIT = 'a'.repeat(40)
const SIGNER = 'Developer ID Application: CatGo Project (ABCDEFGHIJ)'
const TEAM = 'ABCDEFGHIJ'
const DMG = `CatGo_${VERSION}_aarch64.dmg`
const UPDATER = 'CatGo_aarch64.app.tar.gz'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-macos-attestation-'))
  const assets = resolve(root, 'assets')
  mkdirSync(assets)
  writeFileSync(resolve(assets, DMG), 'signed dmg\n')
  writeFileSync(resolve(assets, UPDATER), 'signed updater\n')
  const attestation = {
    schemaVersion: 1,
    releaseTag: TAG,
    sourceCommit: SOURCE_COMMIT,
    githubRunId: '123456789',
    signer: SIGNER,
    teamIdentifier: TEAM,
    artifacts: [
      { name: DMG, sha256: sha256(resolve(assets, DMG)) },
      { name: UPDATER, sha256: sha256(resolve(assets, UPDATER)) },
    ],
  }
  const path = resolve(assets, `catgo-macos-signing-${TAG}.json`)
  writeFileSync(path, `${JSON.stringify(attestation)}\n`)
  return { root, assets, attestation, path }
}

function verify(current) {
  return spawnSync(
    process.execPath,
    [
      VERIFIER,
      '--tag',
      TAG,
      '--source-commit',
      SOURCE_COMMIT,
      '--assets-dir',
      current.assets,
      '--expected-signer',
      SIGNER,
      '--expected-team',
      TEAM,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

function withFixture(assertion) {
  const current = fixture()
  try {
    assertion(current)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
}

test('accepts an exact macOS signing attestation bound to both release artifacts', () => {
  withFixture((current) => {
    const result = verify(current)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

test('rejects a DMG changed after Developer-ID verification', () => {
  withFixture((current) => {
    writeFileSync(resolve(current.assets, DMG), 'replaced dmg\n')
    const result = verify(current)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SHA-256 mismatch.*DMG/i)
  })
})

test('rejects an updater archive changed after attestation', () => {
  withFixture((current) => {
    writeFileSync(resolve(current.assets, UPDATER), 'replaced updater\n')
    const result = verify(current)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SHA-256 mismatch.*updater/i)
  })
})

test('rejects signer, team, source, and schema claims not authorized by the gate', () => {
  for (const mutate of [
    (value) => {
      value.signer = 'Developer ID Application: Intruder (ZZZZZZZZZZ)'
    },
    (value) => {
      value.teamIdentifier = 'ZZZZZZZZZZ'
    },
    (value) => {
      value.sourceCommit = 'b'.repeat(40)
    },
    (value) => {
      value.untrusted = true
    },
  ]) {
    withFixture((current) => {
      const value = JSON.parse(readFileSync(current.path, 'utf8'))
      mutate(value)
      writeFileSync(current.path, `${JSON.stringify(value)}\n`)
      assert.notEqual(verify(current).status, 0)
    })
  }
})

