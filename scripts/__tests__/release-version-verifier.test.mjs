import assert from 'node:assert/strict'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-release-version.mjs')
const VERSION_FILES = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'server/pyproject.toml',
  'extensions/vscode/package.json',
  'CITATION.cff',
  'server/CITATION.cff',
  'extensions/vscode/CITATION.cff',
  'extensions/rust-wasm/CITATION.cff',
]

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-release-version-'))
  for (const path of VERSION_FILES) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(ROOT, path), target)
  }
  return root
}

function runVerifier(root, ...args) {
  return spawnSync(
    process.execPath,
    [VERIFIER, '--root', root, ...args],
    { encoding: 'utf8' },
  )
}

function runVerifierWithEnvironment(root, environment) {
  return spawnSync(process.execPath, [VERIFIER, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
}

function replaceVersion(root, path, from = '1.4.10', to = '1.4.9') {
  const target = resolve(root, path)
  const current = readFileSync(target, 'utf8')
  assert.match(current, new RegExp(from.replaceAll('.', '\\.')), path)
  writeFileSync(target, current.replace(from, to))
}

test('accepts a consistent release tree and its exact v-prefixed tag', () => {
  const root = fixture()
  try {
    const result = runVerifier(root, '--tag', 'v1.4.10')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /release version 1\.4\.10 verified/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts Windows CRLF checkouts', () => {
  const root = fixture()
  try {
    for (const path of VERSION_FILES) {
      const target = resolve(root, path)
      writeFileSync(target, readFileSync(target, 'utf8').replaceAll('\n', '\r\n'))
    }
    const result = runVerifier(root, '--tag', 'v1.4.10')
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects every inconsistent release manifest', async (t) => {
  for (const path of VERSION_FILES.slice(1)) {
    await t.test(path, () => {
      const root = fixture()
      try {
        replaceVersion(root, path)
        const result = runVerifier(root)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, new RegExp(path.replaceAll('/', '\\/')))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('rejects a tag that does not exactly match the manifest version', () => {
  const root = fixture()
  try {
    const result = runVerifier(root, '--tag', 'v1.4.9')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /expected v1\.4\.10/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requires a tag when the caller is publishing', () => {
  const root = fixture()
  try {
    const result = runVerifier(root, '--require-tag')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /release tag is required/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors the workflow tag and publishing requirement environment', () => {
  const root = fixture()
  try {
    const matching = runVerifierWithEnvironment(root, {
      RELEASE_VERSION_TAG: 'v1.4.10',
      RELEASE_VERSION_REQUIRE_TAG: 'true',
    })
    assert.equal(matching.status, 0, matching.stderr)

    const mismatched = runVerifierWithEnvironment(root, {
      RELEASE_VERSION_TAG: 'v1.4.9',
      RELEASE_VERSION_REQUIRE_TAG: 'true',
    })
    assert.notEqual(mismatched.status, 0)
    assert.match(mismatched.stderr, /expected v1\.4\.10/)

    const missing = runVerifierWithEnvironment(root, {
      RELEASE_VERSION_TAG: '',
      RELEASE_VERSION_REQUIRE_TAG: 'true',
    })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /release tag is required/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
