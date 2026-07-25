import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-release-source.mjs')

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr}`,
  )
  return result.stdout.trim()
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-release-source-'))
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'CatGo Test')
  git(root, 'config', 'user.email', 'catgo-test@example.invalid')
  writeFileSync(resolve(root, 'tracked.txt'), 'release\n')
  git(root, 'add', 'tracked.txt')
  git(root, 'commit', '--quiet', '-m', 'release source')
  git(root, 'tag', 'v1.4.6')
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

test('accepts a release whose checked-out source is the exact tag commit', () => {
  const root = fixture()
  try {
    const result = runVerifier(root, '--tag', 'v1.4.6', '--require-tag')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /HEAD .* matches .*v1\.4\.6/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects publishing from a commit other than the release tag', () => {
  const root = fixture()
  try {
    writeFileSync(resolve(root, 'tracked.txt'), 'different source\n')
    git(root, 'add', 'tracked.txt')
    git(root, 'commit', '--quiet', '-m', 'different source')

    const result = runVerifier(root, '--tag', 'v1.4.6', '--require-tag')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /HEAD .* does not match .*v1\.4\.6/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails closed when the requested release tag is unavailable', () => {
  const root = fixture()
  try {
    const result = runVerifier(root, '--tag', 'v9.9.9', '--require-tag')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cannot resolve release tag .*v9\.9\.9/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requires a tag for publication but permits an untagged pure build', () => {
  const root = fixture()
  try {
    const publishing = runVerifier(root, '--require-tag')
    assert.notEqual(publishing.status, 0)
    assert.match(publishing.stderr, /release tag is required/i)

    const buildOnly = runVerifier(root)
    assert.equal(buildOnly.status, 0, buildOnly.stderr)
    assert.match(buildOnly.stdout, /no release tag requested/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors the workflow source tag and requirement environment', () => {
  const root = fixture()
  try {
    const matching = runVerifierWithEnvironment(root, {
      RELEASE_SOURCE_TAG: 'v1.4.6',
      RELEASE_SOURCE_REQUIRE_TAG: 'true',
    })
    assert.equal(matching.status, 0, matching.stderr)

    const missing = runVerifierWithEnvironment(root, {
      RELEASE_SOURCE_TAG: '',
      RELEASE_SOURCE_REQUIRE_TAG: 'true',
    })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /release tag is required/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
