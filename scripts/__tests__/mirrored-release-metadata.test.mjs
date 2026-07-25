import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-mirrored-release.mjs')
const PUBLIC_BASE_URL = 'https://dl.catgo-ucsd.org'

function fixture({
  tag = 'v1.4.5',
  version = tag.slice(1),
  urls = [
    `${PUBLIC_BASE_URL}/${tag}/CatGo_${version}_x64-setup.exe`,
    `${PUBLIC_BASE_URL}/${tag}/CatGo_${version}_aarch64.app.tar.gz`,
  ],
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-r2-metadata-'))
  const assets = resolve(root, 'assets')
  const sourceRoot = resolve(root, 'source')
  mkdirSync(assets)
  mkdirSync(sourceRoot)
  const platforms = Object.fromEntries(
    urls.map((url, index) => [
      `platform-${index}`,
      { url, signature: `signature-${index}` },
    ]),
  )
  writeFileSync(
    resolve(assets, 'latest.json'),
    `${JSON.stringify({ version, platforms })}\n`,
  )
  writeFileSync(resolve(assets, `CatGo_${version}_x64-setup.exe`), 'app\n')
  writeFileSync(
    resolve(assets, `CatGo_${version}_aarch64.app.tar.gz`),
    'updater\n',
  )
  return { root, assets, sourceRoot, tag }
}

function verify(options) {
  return spawnSync(
    process.execPath,
    [
      VERIFIER,
      '--tag',
      options.tag,
      '--assets-dir',
      options.assets,
      '--source-root',
      options.sourceRoot,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, R2_PUBLIC_BASE_URL: PUBLIC_BASE_URL },
    },
  )
}

function withFixture(options, assertion) {
  const current = fixture(options)
  try {
    assertion(verify(current))
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
}

test('accepts updater metadata whose version and Cloudflare asset paths match the tag', () => {
  withFixture({}, (result) => {
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

test('rejects stale updater metadata version', () => {
  withFixture({ version: '1.4.4' }, (result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /latest\.json version.*1\.4\.4.*1\.4\.5/i)
  })
})

test('rejects an updater URL under a stale release tag', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.4/CatGo_1.4.5_x64-setup.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*v1\.4\.5/i)
    },
  )
})

test('rejects mixed Cloudflare and GitHub updater URLs', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.5/CatGo_1.4.5_x64-setup.exe`,
        'https://github.com/Hello-QM/catgo-LRG/releases/download/v1.4.5/CatGo_1.4.5_aarch64.app.tar.gz',
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*Cloudflare/i)
    },
  )
})

test('rejects a Cloudflare URL outside the exact release-tag path', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/releases/v1.4.5/CatGo_1.4.5_x64-setup.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*v1\.4\.5/i)
    },
  )
})
