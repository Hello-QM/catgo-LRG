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

import { syncLegalBundle } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SIDECAR_ASSETS = [
  'catgo-server-linux-x64',
  'catgo-server-darwin-arm64',
  'catgo-server-win-x64.exe',
]

function makeSourceRoot(parent, label) {
  const sourceRoot = resolve(parent, `source-${label}`)
  mkdirSync(resolve(sourceRoot, 'third_party/licenses'), { recursive: true })
  writeFileSync(resolve(sourceRoot, 'license'), `license-${label}\n`)
  writeFileSync(resolve(sourceRoot, 'CITATION.cff'), `citation-${label}\n`)
  writeFileSync(
    resolve(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
    '[dependency](third_party/licenses/dependency.txt)\n',
  )
  writeFileSync(
    resolve(sourceRoot, 'third_party/licenses/dependency.txt'),
    `dependency-${label}\n`,
  )
  return sourceRoot
}

function addSidecars(assets, { corrupt = null } = {}) {
  for (const name of SIDECAR_ASSETS) {
    const body = `sidecar:${name}\n`
    const digest = createHash('sha256').update(body).digest('hex')
    writeFileSync(resolve(assets, name), body)
    writeFileSync(
      resolve(assets, `${name}.sha256`),
      `${corrupt === name ? '0'.repeat(64) : digest}  ${name}\n`,
    )
  }
}

function makeAssets(
  parent,
  tag,
  { includeSidecars = tag !== 'v1.4.5', corruptSidecar = null } = {},
) {
  const assets = resolve(parent, `assets-${tag}`)
  mkdirSync(assets, { recursive: true })
  writeFileSync(
    resolve(assets, 'latest.json'),
    `${JSON.stringify({
      version: tag.slice(1),
      platforms: {
        'linux-x86_64': {
          url: `https://dl.catgo-ucsd.org/${tag}/CatGo_${tag}_amd64.deb`,
          signature: 'signed-updater-fixture',
        },
      },
    })}\n`,
  )
  writeFileSync(resolve(assets, `CatGo_${tag}_amd64.deb`), 'app\n')
  if (includeSidecars) addSidecars(assets, { corrupt: corruptSidecar })
  return assets
}

function addLegalArchive(parent, assets, sourceRoot, name = 'expected') {
  const staged = resolve(parent, `staged-${name}`)
  syncLegalBundle(staged, { sourceRoot })
  const archive = resolve(assets, 'catgo-legal-bundle.tar.gz')
  const result = spawnSync('tar', ['czf', archive, '-C', staged, '.'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function verify(tag, assets, sourceRoot) {
  return spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'scripts/verify-mirrored-release.mjs'),
      '--tag',
      tag,
      '--assets-dir',
      assets,
      '--source-root',
      sourceRoot,
      '--json',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('v1.4.5 historical backfill validates app assets without an NCL archive', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-historical-'))
  try {
    const sourceRoot = makeSourceRoot(fixture, 'historical')
    const assets = makeAssets(fixture, 'v1.4.5')
    const result = verify('v1.4.5', assets, sourceRoot)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).policy, 'historical-pre-1.4.6')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('v1.4.5 historical backfill still requires valid updater and app assets', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-historical-bad-'))
  try {
    const sourceRoot = makeSourceRoot(fixture, 'historical')
    const assets = resolve(fixture, 'assets')
    mkdirSync(assets)
    const result = verify('v1.4.5', assets, sourceRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /latest\.json|app asset/i)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

for (const tag of ['v1.4.6', 'v2.0.0']) {
  test(`${tag} validates the legal archive against that tag's source`, () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-ncl-'))
    try {
      const sourceRoot = makeSourceRoot(fixture, tag)
      const assets = makeAssets(fixture, tag)
      addLegalArchive(fixture, assets, sourceRoot, tag)
      const result = verify(tag, assets, sourceRoot)
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).policy, 'ncl-1.4.6-or-later')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
}

test('future release rejects a legal archive built from another branch', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-wrong-source-'))
  try {
    const targetSource = makeSourceRoot(fixture, 'future-target')
    const defaultSource = makeSourceRoot(fixture, 'future-default')
    const assets = makeAssets(fixture, 'v1.5.0')
    addLegalArchive(fixture, assets, defaultSource, 'default')
    const result = verify('v1.5.0', assets, targetSource)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /does not match|mismatch/i)

    assert.equal(
      readFileSync(resolve(targetSource, 'license'), 'utf8'),
      'license-future-target\n',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('v1.4.6 rejects a release missing version-coupled sidecar checksums', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-no-sidecars-'))
  try {
    const sourceRoot = makeSourceRoot(fixture, 'no-sidecars')
    const assets = makeAssets(
      fixture,
      'v1.4.6',
      { includeSidecars: false },
    )
    addLegalArchive(fixture, assets, sourceRoot, 'no-sidecars')
    const result = verify('v1.4.6', assets, sourceRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing sidecar.*linux-x64/i)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('v1.4.6 rejects a sidecar whose SHA-256 receipt does not match', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-r2-bad-sidecar-'))
  try {
    const sourceRoot = makeSourceRoot(fixture, 'bad-sidecar')
    const assets = makeAssets(
      fixture,
      'v1.4.6',
      { corruptSidecar: 'catgo-server-darwin-arm64' },
    )
    addLegalArchive(fixture, assets, sourceRoot, 'bad-sidecar')
    const result = verify('v1.4.6', assets, sourceRoot)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /checksum mismatch.*darwin-arm64/i)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
