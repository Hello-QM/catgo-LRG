import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyReleaseRights } from '../verify-release-rights.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-release-rights.mjs')

function fixture(ledgers) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-release-rights-'))
  const provenance = resolve(root, 'third_party/provenance')
  mkdirSync(provenance, { recursive: true })
  for (const [name, contents] of Object.entries(ledgers)) {
    mkdirSync(dirname(resolve(provenance, name)), { recursive: true })
    writeFileSync(
      resolve(provenance, name),
      `${JSON.stringify(contents)}\n`,
    )
  }
  return root
}

function writeFixture(root, path, contents) {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function releaseEvidence(root, paths) {
  const files = []
  const visit = (path) => {
    const stat = lstatSync(path)
    if (stat.isFile()) {
      files.push(path)
      return
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visit(resolve(path, entry.name))
    }
  }
  for (const path of paths) visit(resolve(root, path.replace(/\/$/, '')))
  const unique = [...new Set(files.map((path) =>
    relative(root, path).split(sep).join('/'))
  )].sort()
  const manifest = unique.map((path) => {
    const digest = createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex')
    return `${digest}  ${path}\n`
  }).join('')
  return {
    algorithm: 'sha256sum-manifest-v1',
    fileCount: unique.length,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  }
}

function writeLedger(root, name, contents) {
  writeFixture(
    root,
    `third_party/provenance/${name}`,
    `${JSON.stringify(contents)}\n`,
  )
}

function verify(root) {
  return spawnSync(
    process.execPath,
    [VERIFIER, '--root', root],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('accepts a CLEARED provenance ledger', () => {
  const root = fixture({
    'approved.json': {
      schemaVersion: 1,
      releaseStatus: 'CLEARED',
      evidence: 'written permission archived outside this fixture',
    },
  })
  try {
    assert.deepEqual(verifyReleaseRights(root), [
      { ledger: 'approved.json', status: 'CLEARED' },
    ])
    const result = verify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /VERIFIED: 1 ledger/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts NOTICE_BACKED only with regular included notice files', () => {
  const root = fixture({})
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'src/component.js', 'export {}\n')
  writeLedger(root, 'open-source.json', {
    schemaVersion: 1,
    releaseStatus: 'NOTICE_BACKED',
    noticeFiles: ['third_party/licenses/component-MIT.txt'],
    coveredPaths: ['src/component.js'],
    releaseEvidence: releaseEvidence(root, [
      'third_party/licenses/component-MIT.txt',
      'src/component.js',
    ]),
  })
  try {
    assert.deepEqual(verifyReleaseRights(root), [
      { ledger: 'open-source.json', status: 'NOTICE_BACKED' },
    ])
    const result = verify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /VERIFIED: 1 ledger/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts NOTICE_BACKED covered directories with nested regular files', () => {
  const root = fixture({})
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'vendor/component/index.js', 'export {}\n')
  writeFixture(root, 'vendor/component/lib/helper.js', 'export {}\n')
  writeLedger(root, 'vendor-component.json', {
    schemaVersion: 1,
    releaseStatus: 'NOTICE_BACKED',
    noticeFiles: ['third_party/licenses/component-MIT.txt'],
    coveredPaths: ['vendor/component/'],
    releaseEvidence: releaseEvidence(root, [
      'third_party/licenses/component-MIT.txt',
      'vendor/component/',
    ]),
  })
  try {
    assert.deepEqual(verifyReleaseRights(root), [
      { ledger: 'vendor-component.json', status: 'NOTICE_BACKED' },
    ])
    const result = verify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /VERIFIED: 1 ledger/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the repository's notice-backed provenance ledgers are both release-verifiable", () => {
  assert.deepEqual(verifyReleaseRights(ROOT), [
    { ledger: 'pormake-database-provenance.json', status: 'NOTICE_BACKED' },
    { ledger: 'pymatgen-ase-xterm-provenance.json', status: 'NOTICE_BACKED' },
  ])
  const result = verify(ROOT)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /VERIFIED: 2 ledgers/i)
})

test('release-evidence text bytes are pinned to LF on every checkout platform', () => {
  const attributes = readFileSync(resolve(ROOT, '.gitattributes'), 'utf8')
  for (const pattern of [
    '/THIRD_PARTY_NOTICES.md text eol=lf',
    '/server/catgo/vendor/pormake/LICENSE text eol=lf',
    '/server/catgo/vendor/pormake/database/**/*.cgd text eol=lf',
    '/server/catgo/vendor/pormake/database/**/*.xyz text eol=lf',
    '/server/catgo/vendor/pormake/database/**/*.txt text eol=lf',
    '/server/catgo/vendor/pormake/database/**/*.zip -text',
    '/third_party/licenses/*.txt text eol=lf',
    '/extensions/rust/src/**/*.rs text eol=lf',
    '/src/lib/structure/TerminalPanel.svelte text eol=lf',
    '/src/lib/xrd/*.ts text eol=lf',
  ]) {
    assert.match(
      attributes,
      new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `${pattern} must remain checkout-stable`,
    )
  }
})

test('blocks NOTICE_BACKED when covered bytes no longer match release evidence', () => {
  const root = fixture({})
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'vendor/component/index.js', 'export const value = 1\n')
  writeLedger(root, 'vendor-component.json', {
    schemaVersion: 1,
    releaseStatus: 'NOTICE_BACKED',
    noticeFiles: ['third_party/licenses/component-MIT.txt'],
    coveredPaths: ['vendor/component/'],
    releaseEvidence: releaseEvidence(root, [
      'third_party/licenses/component-MIT.txt',
      'vendor/component/',
    ]),
  })
  writeFixture(root, 'vendor/component/index.js', 'export const value = 2\n')
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'changed covered bytes must fail closed')
    assert.match(result.stderr, /release evidence.*manifest/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED with an unsupported ledger schema', () => {
  const root = fixture({})
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'src/component.js', 'export {}\n')
  writeLedger(root, 'open-source.json', {
    schemaVersion: 2,
    releaseStatus: 'NOTICE_BACKED',
    noticeFiles: ['third_party/licenses/component-MIT.txt'],
    coveredPaths: ['src/component.js'],
    releaseEvidence: releaseEvidence(root, [
      'third_party/licenses/component-MIT.txt',
      'src/component.js',
    ]),
  })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'unknown schemas must fail closed')
    assert.match(result.stderr, /schemaVersion/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED covered directories with no regular files', () => {
  const root = fixture({
    'empty-vendor-component.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/component-MIT.txt'],
      coveredPaths: ['vendor/component/'],
    },
  })
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  mkdirSync(resolve(root, 'vendor/component'), { recursive: true })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'empty covered directories must fail closed')
    assert.match(result.stderr, /empty-vendor-component\.json.*coveredPaths/i)
    assert.match(result.stderr, /regular file/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED covered directories containing symlinks', () => {
  const root = fixture({
    'linked-vendor-component.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/component-MIT.txt'],
      coveredPaths: ['vendor/component/'],
    },
  })
  const outside = resolve(root, 'outside-component.js')
  const linked = resolve(root, 'vendor/component/linked.js')
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFileSync(outside, 'export {}\n')
  mkdirSync(dirname(linked), { recursive: true })
  symlinkSync(outside, linked)
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'symlinked covered files must fail closed')
    assert.match(result.stderr, /linked-vendor-component\.json.*coveredPaths/i)
    assert.match(result.stderr, /symlink/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED ledgers without noticeFiles or coveredPaths', () => {
  const root = fixture({
    'missing-notices.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      coveredPaths: ['src/component.js'],
    },
    'missing-covered-paths.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/component-MIT.txt'],
    },
  })
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'src/component.js', 'export {}\n')
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'incomplete notice evidence must fail closed')
    assert.match(result.stderr, /missing-notices\.json.*noticeFiles/i)
    assert.match(result.stderr, /missing-covered-paths\.json.*coveredPaths/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED ledgers with missing, absolute, or traversal notice files', () => {
  const root = fixture({
    'missing-file.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/missing.txt'],
      coveredPaths: ['src/component.js'],
    },
    'absolute-file.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['/tmp/component-MIT.txt'],
      coveredPaths: ['src/component.js'],
    },
    'traversal-file.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/../component-MIT.txt'],
      coveredPaths: ['src/component.js'],
    },
  })
  writeFixture(root, 'third_party/licenses/component-MIT.txt', 'MIT\n')
  writeFixture(root, 'src/component.js', 'export {}\n')
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'unsafe notice paths must fail closed')
    assert.match(result.stderr, /missing-file\.json.*missing\.txt/i)
    assert.match(result.stderr, /absolute-file\.json.*absolute/i)
    assert.match(result.stderr, /traversal-file\.json.*traversal/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks NOTICE_BACKED ledgers with symlinked notice files', () => {
  const root = fixture({
    'linked-notice.json': {
      schemaVersion: 1,
      releaseStatus: 'NOTICE_BACKED',
      noticeFiles: ['third_party/licenses/component-MIT.txt'],
      coveredPaths: ['src/component.js'],
    },
  })
  const outside = resolve(root, 'outside-MIT.txt')
  const linked = resolve(root, 'third_party/licenses/component-MIT.txt')
  writeFixture(root, 'src/component.js', 'export {}\n')
  writeFileSync(outside, 'MIT\n')
  mkdirSync(dirname(linked), { recursive: true })
  symlinkSync(outside, linked)
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'symlinked notice evidence must fail closed')
    assert.match(result.stderr, /linked-notice\.json.*symlink/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks release when a provenance ledger is BLOCKED', () => {
  const root = fixture({
    'pormake-database-provenance.json': {
      schemaVersion: 1,
      releaseStatus: 'BLOCKED',
      externalRightsGate: 'written permission or exclusion',
    },
  })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'BLOCKED rights must fail closed')
    assert.match(result.stderr, /pormake-database-provenance\.json/)
    assert.match(result.stderr, /BLOCKED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks release when provenance status is missing or unrecognized', () => {
  const root = fixture({
    'missing-status.json': {
      schemaVersion: 1,
      scope: 'technical provenance with no release decision',
    },
    'review-required.json': {
      schemaVersion: 1,
      releaseStatus: 'REVIEW_REQUIRED',
    },
    'excluded.json': {
      schemaVersion: 1,
      releaseStatus: 'EXCLUDED',
    },
    'unsupported.json': {
      schemaVersion: 1,
      releaseStatus: 'SOMEDAY',
    },
  })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'unknown rights must fail closed')
    assert.match(result.stderr, /missing-status\.json.*UNKNOWN/)
    assert.match(result.stderr, /review-required\.json.*REVIEW_REQUIRED/)
    assert.match(result.stderr, /excluded\.json.*EXCLUDED/)
    assert.match(result.stderr, /unsupported\.json.*SOMEDAY/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks release when no machine-readable provenance ledger exists', () => {
  const root = fixture({})
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'missing rights evidence must fail closed')
    assert.match(result.stderr, /no machine-readable provenance ledger/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blocks nested machine-readable provenance ledgers', () => {
  const root = fixture({
    'datasets/restricted.json': {
      schemaVersion: 1,
      releaseStatus: 'BLOCKED',
    },
  })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'nested BLOCKED rights must fail closed')
    assert.match(result.stderr, /datasets\/restricted\.json.*BLOCKED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a symlinked third_party directory before reading external ledgers', () => {
  const root = fixture({})
  const external = mkdtempSync(resolve(tmpdir(), 'catgo-external-rights-'))
  const thirdParty = resolve(root, 'third_party')
  rmSync(thirdParty, { recursive: true, force: true })
  writeFixture(external, 'provenance/external-clearance.json', '{ malformed')
  symlinkSync(external, thirdParty, 'dir')
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'symlinked third_party must fail closed')
    assert.match(result.stderr, /third_party.*symlink/i)
    assert.doesNotMatch(result.stderr, /unexpected token/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('rejects a symlinked provenance directory before reading external ledgers', () => {
  const root = fixture({})
  const external = mkdtempSync(resolve(tmpdir(), 'catgo-external-rights-'))
  const provenance = resolve(root, 'third_party/provenance')
  rmSync(provenance, { recursive: true, force: true })
  writeFixture(external, 'external-clearance.json', '{ malformed')
  symlinkSync(external, provenance, 'dir')
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'symlinked provenance must fail closed')
    assert.match(result.stderr, /provenance.*symlink/i)
    assert.doesNotMatch(result.stderr, /unexpected token/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('rejects symlinked provenance instead of following external clearance', () => {
  const root = fixture({})
  const outside = resolve(root, 'outside-cleared.json')
  const linked = resolve(
    root,
    'third_party/provenance/external-clearance.json',
  )
  writeFileSync(
    outside,
    `${JSON.stringify({ releaseStatus: 'CLEARED' })}\n`,
  )
  symlinkSync(outside, linked)
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'symlinked rights must fail closed')
    assert.match(result.stderr, /external-clearance\.json.*symlink/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
