import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as legalSync from '../sync-legal-bundle.mjs'
import {
  activeRunScriptsFromWorkflow,
  assertActiveWorkflowRun,
  verifyStagedLegalBundles,
} from '../verify-legal-distributions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'

const REQUIRED_FILES = [
  ...legalSync.legalBundleSources(),
  'ACKNOWLEDGEMENT.txt',
]
const OWNERSHIP_MARKER = '.catgo-legal-bundle-owned'

const DISTRIBUTION_CLASSES = [
  'android-apk-aab',
  'docker-image',
  'github-release',
  'hpc-bundle',
  'ios-ipa-testflight',
  'stt-accelerator-archives',
  'tauri-desktop-bundles',
  'vscode-sidecar-binaries',
  'web-app-static',
  'web-docs-static',
]

function runNode(script, args = []) {
  return spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

test('canonical legal sources cover every provenance ledger referenced by the notice', () => {
  const notice = readFileSync(resolve(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const referenced = [
    ...new Set(
      [...notice.matchAll(/third_party\/provenance\/[A-Za-z0-9._/-]+\.(?:json|md)/g)]
        .map((match) => match[0]),
    ),
  ].sort()
  const bundled = legalSync.legalBundleSources()
    .filter((path) => path.startsWith('third_party/provenance/'))
    .sort()

  assert.deepEqual(bundled, referenced)
})

test('canonical sync stages the complete redistribution bundle byte-for-byte', () => {
  const output = mkdtempSync(join(tmpdir(), 'catgo-legal-bundle-'))
  try {
    const result = runNode('scripts/sync-legal-bundle.mjs', ['--output', output])
    assert.equal(result.status, 0, result.stderr || result.stdout)

    for (const path of REQUIRED_FILES) {
      const staged = readFileSync(resolve(output, path))
      if (path === 'ACKNOWLEDGEMENT.txt') {
        assert.equal(staged.toString('utf8'), `${ACK}\n`, path)
      } else {
        assert.deepEqual(staged, readFileSync(resolve(ROOT, path)), path)
      }
    }
    assert.ok(existsSync(resolve(output, OWNERSHIP_MARKER)))
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('release verification compares staged and package-local bundles to canonical sources', () => {
  assert.equal(
    typeof legalSync.DEFAULT_TARGETS,
    'object',
    'sync module must expose every canonical staging target',
  )
  assert.equal(
    typeof verifyStagedLegalBundles,
    'function',
    'release verifier must expose staged-byte verification',
  )
  assert.doesNotThrow(() => verifyStagedLegalBundles())
})

test('canonical package sync stages notice-linked licenses and provenance byte-for-byte', () => {
  assert.equal(
    typeof legalSync.syncPackageLegalBundles,
    'function',
    'sync module must expose canonical package-local synchronization',
  )
  const sourceRoot = mkdtempSync(join(tmpdir(), 'catgo-package-legal-source-'))
  const packageParent = mkdtempSync(join(tmpdir(), 'catgo-package-legal-targets-'))
  const packageTargets = [
    { root: resolve(packageParent, 'wasm'), licenseName: 'license' },
    { root: resolve(packageParent, 'vscode'), licenseName: 'license' },
    { root: resolve(packageParent, 'server'), licenseName: 'LICENSE' },
  ]
  try {
    mkdirSync(resolve(sourceRoot, 'third_party/licenses'), { recursive: true })
    mkdirSync(resolve(sourceRoot, 'third_party/provenance'), { recursive: true })
    writeFileSync(resolve(sourceRoot, 'license'), 'root license\n')
    writeFileSync(resolve(sourceRoot, 'CITATION.cff'), 'citation\n')
    writeFileSync(
      resolve(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
      [
        '[dependency](third_party/licenses/dependency.txt)',
        '[ledger](third_party/provenance/ledger.json)',
        '',
      ].join('\n'),
    )
    writeFileSync(
      resolve(sourceRoot, 'third_party/licenses/dependency.txt'),
      'dependency license\n',
    )
    writeFileSync(
      resolve(sourceRoot, 'third_party/provenance/ledger.json'),
      '{"schemaVersion":1}\n',
    )
    for (const { root } of packageTargets) mkdirSync(root, { recursive: true })

    legalSync.syncPackageLegalBundles({ sourceRoot, packageTargets })

    for (const { root, licenseName } of packageTargets) {
      assert.equal(readFileSync(resolve(root, licenseName), 'utf8'), 'root license\n')
      for (const path of [
        'CITATION.cff',
        'THIRD_PARTY_NOTICES.md',
        'third_party/licenses/dependency.txt',
        'third_party/provenance/ledger.json',
      ]) {
        assert.deepEqual(
          readFileSync(resolve(root, path)),
          readFileSync(resolve(sourceRoot, path)),
          `${root}: ${path}`,
        )
      }
    }
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true })
    rmSync(packageParent, { recursive: true, force: true })
  }
})

test('target validation rejects repo, home, system roots, and broad ancestors', () => {
  assert.equal(
    typeof legalSync.validateLegalBundleTarget,
    'function',
    'sync module must expose side-effect-free target validation',
  )
  for (const unsafe of [
    ROOT,
    resolve(ROOT, '..'),
    homedir(),
    resolve('/'),
    resolve('/etc'),
    tmpdir(),
    resolve('/usr'),
  ]) {
    assert.throws(
      () => legalSync.validateLegalBundleTarget(unsafe),
      /unsafe|protected|refus/i,
      unsafe,
    )
  }
})

test('custom output refuses a non-owned existing directory without deleting it', () => {
  const output = mkdtempSync(join(tmpdir(), 'catgo-unowned-output-'))
  const sentinel = resolve(output, 'KEEP-ME.txt')
  writeFileSync(sentinel, 'unrelated data\n')
  try {
    const result = runNode('scripts/sync-legal-bundle.mjs', ['--output', output])
    assert.notEqual(result.status, 0, 'non-owned non-empty output must fail')
    assert.equal(readFileSync(sentinel, 'utf8'), 'unrelated data\n')
    assert.equal(existsSync(resolve(output, 'license')), false)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('custom output may refresh only after the tool has marked ownership', () => {
  const parent = mkdtempSync(join(tmpdir(), 'catgo-owned-output-'))
  const output = resolve(parent, 'legal')
  try {
    const first = runNode('scripts/sync-legal-bundle.mjs', ['--output', output])
    assert.equal(first.status, 0, first.stderr || first.stdout)
    assert.ok(existsSync(resolve(output, OWNERSHIP_MARKER)))

    writeFileSync(resolve(output, 'stale-generated-file.txt'), 'stale\n')
    const second = runNode('scripts/sync-legal-bundle.mjs', ['--output', output])
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.equal(existsSync(resolve(output, 'stale-generated-file.txt')), false)
    assert.ok(existsSync(resolve(output, OWNERSHIP_MARKER)))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('custom output refuses a symlink target without touching its referent', () => {
  const parent = mkdtempSync(join(tmpdir(), 'catgo-symlink-target-'))
  const referent = resolve(parent, 'referent')
  const target = resolve(parent, 'legal-link')
  mkdirSync(referent)
  writeFileSync(resolve(referent, 'KEEP-ME.txt'), 'unrelated data\n')
  symlinkSync(referent, target)
  try {
    const result = runNode('scripts/sync-legal-bundle.mjs', ['--output', target])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /symlink/i)
    assert.equal(
      readFileSync(resolve(referent, 'KEEP-ME.txt'), 'utf8'),
      'unrelated data\n',
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('notice traversal is rejected before an output directory is touched', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'catgo-malicious-notice-'))
  const output = mkdtempSync(join(tmpdir(), 'catgo-untouched-output-'))
  const sentinel = resolve(output, 'KEEP-ME.txt')
  writeFileSync(resolve(sourceRoot, 'license'), 'license\n')
  writeFileSync(resolve(sourceRoot, 'CITATION.cff'), 'citation\n')
  writeFileSync(
    resolve(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
    '[escape](../outside/LICENSE)\n',
  )
  writeFileSync(sentinel, 'untouched\n')
  try {
    assert.throws(
      () => legalSync.syncLegalBundle(output, { sourceRoot }),
      /traversal|outside|source/i,
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched\n')
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true })
    rmSync(output, { recursive: true, force: true })
  }
})

test('symlinked notice sources cannot escape the canonical source root', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'catgo-symlink-source-'))
  const outside = mkdtempSync(join(tmpdir(), 'catgo-outside-source-'))
  const outputParent = mkdtempSync(join(tmpdir(), 'catgo-symlink-output-'))
  const output = resolve(outputParent, 'legal')
  try {
    for (const path of ['license', 'CITATION.cff']) {
      writeFileSync(resolve(sourceRoot, path), `${path}\n`)
    }
    mkdirSync(resolve(sourceRoot, 'third_party/licenses'), { recursive: true })
    writeFileSync(
      resolve(sourceRoot, 'THIRD_PARTY_NOTICES.md'),
      '[linked](third_party/licenses/linked.txt)\n',
    )
    writeFileSync(resolve(outside, 'linked.txt'), 'outside\n')
    symlinkSync(
      resolve(outside, 'linked.txt'),
      resolve(sourceRoot, 'third_party/licenses/linked.txt'),
    )

    assert.throws(
      () => legalSync.syncLegalBundle(output, { sourceRoot }),
      /symlink|outside|source/i,
    )
    assert.equal(existsSync(output), false)
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(outputParent, { recursive: true, force: true })
  }
})

test('workflow checks ignore comments and statically disabled jobs or steps', () => {
  const fixture = `
name: Negative semantic fixture
jobs:
  disabled-job:
    if: false
    steps:
      - run: pnpm legal:verify
  active-job:
    steps:
      - if: \${{ false }}
        run: node scripts/verify-stt-archive.mjs
      - run: |
          # gh release upload commented-out.tar.gz
          echo "fixture remains active" # pnpm legal:verify
`
  assert.deepEqual(activeRunScriptsFromWorkflow(fixture), [
    'echo "fixture remains active"',
  ])
  assert.throws(
    () => assertActiveWorkflowRun(fixture, /pnpm legal:verify/),
    /active workflow command/i,
  )
  assert.throws(
    () => assertActiveWorkflowRun(fixture, /verify-stt-archive/),
    /active workflow command/i,
  )
  assert.throws(
    () => assertActiveWorkflowRun(fixture, /gh release upload/),
    /active workflow command/i,
  )
  assert.doesNotThrow(() =>
    assertActiveWorkflowRun(fixture, /echo "fixture remains active"/),
  )
})

test('release verifier validates configuration contracts for every application distribution class', () => {
  const result = runNode('scripts/verify-legal-distributions.mjs', ['--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.classes, DISTRIBUTION_CLASSES)
  assert.equal(report.acknowledgement, ACK)
  assert.equal(report.requiredFiles, REQUIRED_FILES.length)
  assert.equal(report.verificationLevel, 'configuration-contracts')
})
