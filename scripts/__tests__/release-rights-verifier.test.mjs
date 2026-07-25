import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

function verify(root) {
  return spawnSync(
    process.execPath,
    [VERIFIER, '--root', root],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('accepts release only when every provenance ledger is explicitly CLEARED', () => {
  const root = fixture({
    'approved.json': {
      schemaVersion: 1,
      releaseStatus: 'CLEARED',
      evidence: 'written permission archived outside this fixture',
    },
  })
  try {
    const result = verify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /CLEARED.*1.*ledger/i)
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
  })
  try {
    const result = verify(root)
    assert.notEqual(result.status, 0, 'unknown rights must fail closed')
    assert.match(result.stderr, /missing-status\.json.*UNKNOWN/)
    assert.match(result.stderr, /review-required\.json.*REVIEW_REQUIRED/)
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
