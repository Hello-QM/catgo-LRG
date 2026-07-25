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

import { RELEASE_TRUST_POLICY } from '../release-trust-policy.mjs'
import { syncLegalBundle } from '../sync-legal-bundle.mjs'
import {
  createTauriSigningFixture,
  tamperInlineTauriSignature,
} from './helpers/tauri-signing-fixture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-mirrored-release.mjs')
const FIXTURE_VERIFIER = resolve(
  ROOT,
  'scripts/__tests__/helpers/run-mirrored-release-verifier.mjs',
)
const PUBLIC_BASE_URL = 'https://dl.catgo-ucsd.org'
const SIDECAR_ASSETS = [
  'catgo-server-linux-x64',
  'catgo-server-darwin-arm64',
  'catgo-server-win-x64.exe',
]
const REQUIRED_RELEASE_ASSETS = [
  'CatGo_1.4.6_x64_en-US.msi',
  'CatGo_1.4.6_aarch64.dmg',
  'CatGo_1.4.6_amd64.deb',
  'CatGo-1.4.6-1.x86_64.rpm',
  'CatGo-v1.4.6-android-universal.apk',
  'catgo-hpc-bundle.tar.gz',
  'catgo-1.4.6.vsix',
]

function addReleaseBundle(root, assets, sourceRoot) {
  mkdirSync(resolve(sourceRoot, 'third_party/licenses'), { recursive: true })
  writeFileSync(resolve(sourceRoot, 'license'), 'fixture license\n')
  writeFileSync(resolve(sourceRoot, 'CITATION.cff'), 'fixture citation\n')
  writeFileSync(
    resolve(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
    '[dependency](third_party/licenses/dependency.txt)\n',
  )
  writeFileSync(
    resolve(sourceRoot, 'third_party/licenses/dependency.txt'),
    'fixture dependency license\n',
  )
  const staged = resolve(root, 'legal-bundle')
  syncLegalBundle(staged, { sourceRoot })
  const archive = spawnSync(
    'tar',
    ['czf', resolve(assets, 'catgo-legal-bundle.tar.gz'), '-C', staged, '.'],
    { encoding: 'utf8' },
  )
  assert.equal(archive.status, 0, archive.stderr || archive.stdout)

  for (const name of SIDECAR_ASSETS) {
    const body = `sidecar:${name}\n`
    const digest = createHash('sha256').update(body).digest('hex')
    writeFileSync(resolve(assets, name), body)
    writeFileSync(resolve(assets, `${name}.sha256`), `${digest}  ${name}\n`)
  }
}

function fixture({
  tag = 'v1.4.6',
  version = tag.slice(1),
  signature = undefined,
  omitRequiredAsset = null,
  publicBaseUrl = PUBLIC_BASE_URL,
  platformNames = ['windows-x86_64', 'darwin-aarch64'],
  urls = [
    `${PUBLIC_BASE_URL}/${tag}/CatGo_${version}_x64-setup.exe`,
    `${PUBLIC_BASE_URL}/${tag}/CatGo_aarch64.app.tar.gz`,
  ],
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-r2-metadata-'))
  const assets = resolve(root, 'assets')
  const sourceRoot = resolve(root, 'source')
  mkdirSync(assets)
  mkdirSync(sourceRoot)
  const signer = createTauriSigningFixture(sourceRoot)
  const windowsUpdater = resolve(assets, `CatGo_${version}_x64-setup.exe`)
  const macosUpdater = resolve(assets, 'CatGo_aarch64.app.tar.gz')
  writeFileSync(windowsUpdater, 'app\n')
  writeFileSync(macosUpdater, 'updater\n')
  const updaterSignatures = [
    signer.signArtifact(windowsUpdater),
    signer.signArtifact(macosUpdater),
  ]
  const platforms = Object.fromEntries(
    urls.map((url, index) => [
      platformNames[index] ?? `platform-${index}`,
      {
        url,
        ...(signature === null
          ? {}
          : {
              signature:
                typeof signature === 'function'
                  ? signature(updaterSignatures[index], index)
                  : updaterSignatures[index],
            }),
      },
    ]),
  )
  writeFileSync(
    resolve(assets, 'latest.json'),
    `${JSON.stringify({ version, platforms })}\n`,
  )
  for (const name of REQUIRED_RELEASE_ASSETS) {
    const versionedName = name.replaceAll('1.4.6', version)
    if (versionedName !== omitRequiredAsset) {
      writeFileSync(resolve(assets, versionedName), `release:${name}\n`)
    }
  }
  addReleaseBundle(root, assets, sourceRoot)
  return {
    root,
    assets,
    sourceRoot,
    tag,
    publicBaseUrl,
    signer,
    windowsUpdater,
  }
}

function verify(options, { productionPolicy = false } = {}) {
  const args = productionPolicy
    ? [
        VERIFIER,
        '--tag',
        options.tag,
        '--assets-dir',
        options.assets,
        '--source-root',
        options.sourceRoot,
      ]
    : [
        FIXTURE_VERIFIER,
        options.tag,
        options.assets,
        options.sourceRoot,
        options.publicBaseUrl,
        'false',
      ]
  return spawnSync(
    process.execPath,
    args,
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        R2_PUBLIC_BASE_URL: options.publicBaseUrl,
        ...(productionPolicy
          ? {}
          : {
              CATGO_TEST_APPROVED_TAURI_UPDATER_PUBKEY:
                options.signer.updaterPubkey,
            }),
      },
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

test('accepts updater metadata signed by the trust-policy updater key', () => {
  withFixture({}, (result) => {
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

test('rejects a target-source key replacement even when it self-signs every updater', () => {
  const current = fixture()
  try {
    const result = verify(current, { productionPolicy: true })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /updater public key.*approved.*trust policy/i)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('pins the approved updater key to the default-branch Tauri config', () => {
  const config = JSON.parse(
    readFileSync(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
  )
  assert.equal(
    RELEASE_TRUST_POLICY.tauriUpdaterPubkey,
    config.plugins.updater.pubkey,
  )
})

test('rejects stale updater metadata version', () => {
  withFixture({ version: '1.4.4' }, (result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /latest\.json version.*1\.4\.4.*1\.4\.6/i)
  })
})

test('rejects an updater URL under a stale release tag', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.4/CatGo_1.4.6_x64-setup.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*v1\.4\.6/i)
    },
  )
})

test('rejects mixed Cloudflare and GitHub updater URLs', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.6/CatGo_1.4.6_x64-setup.exe`,
        'https://github.com/Hello-QM/catgo-LRG/releases/download/v1.4.6/CatGo_1.4.6_aarch64.app.tar.gz',
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*Cloudflare/i)
    },
  )
})

test('rejects a mutable non-CatGo HTTPS mirror origin', () => {
  withFixture(
    {
      publicBaseUrl: 'https://example.com',
      urls: [
        'https://example.com/v1.4.6/CatGo_1.4.6_x64-setup.exe',
        'https://example.com/v1.4.6/CatGo_aarch64.app.tar.gz',
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /must be exactly https:\/\/dl\.catgo-ucsd\.org/i)
    },
  )
})

test('rejects a Cloudflare URL outside the exact release-tag path', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/releases/v1.4.6/CatGo_1.4.6_x64-setup.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /updater URL.*v1\.4\.6/i)
    },
  )
})

test('rejects updater metadata without an artifact signature', () => {
  withFixture({ signature: null }, (result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /signature.*windows-x86_64/i)
  })
})

test('rejects an updater artifact modified after its signature was created', () => {
  const current = fixture()
  try {
    writeFileSync(current.windowsUpdater, 'tampered app\n')
    const result = verify(current)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /signature verification failed.*windows-x86_64/i)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('rejects a tampered inline Tauri updater signature', () => {
  withFixture(
    {
      signature: (valid, index) =>
        index === 0 ? tamperInlineTauriSignature(valid) : valid,
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /signature verification failed.*windows-x86_64/i)
    },
  )
})

test('rejects updater signatures made by a different key', () => {
  const current = fixture()
  try {
    const otherSource = resolve(current.root, 'other-source')
    mkdirSync(otherSource)
    const otherSigner = createTauriSigningFixture(otherSource)
    const latestPath = resolve(current.assets, 'latest.json')
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'))
    latest.platforms['windows-x86_64'].signature =
      otherSigner.signArtifact(current.windowsUpdater)
    writeFileSync(latestPath, `${JSON.stringify(latest)}\n`)

    const result = verify(current)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /signature key.*does not match.*windows-x86_64/i)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('rejects an updater URL whose release asset is absent', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.6/CatGo_1.4.6_amd64.AppImage`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /missing.*release asset/i)
    },
  )
})

test('rejects a sidecar binary as a Tauri updater artifact', () => {
  withFixture(
    {
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.6/catgo-server-win-x64.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /recognized Tauri updater artifact/i)
    },
  )
})

test('rejects a partial release even when updater metadata itself is valid', () => {
  withFixture(
    { omitRequiredAsset: 'CatGo-v1.4.6-android-universal.apk' },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /missing required release asset.*Android/i)
    },
  )
})

test('rejects stale installers that could shadow the current download', () => {
  const current = fixture()
  try {
    const stale = 'CatGo_1.4.5_x64-setup.exe'
    writeFileSync(resolve(current.assets, stale), 'stale installer\n')
    const result = verify(current)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unexpected release installer.*v1\.4\.6.*1\.4\.5/i)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('rejects updater metadata missing a required desktop updater platform', () => {
  withFixture(
    {
      platformNames: ['windows-x86_64'],
      urls: [
        `${PUBLIC_BASE_URL}/v1.4.6/CatGo_1.4.6_x64-setup.exe`,
      ],
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /missing required updater platform.*darwin-aarch64/i)
    },
  )
})
