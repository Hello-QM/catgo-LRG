import assert from 'node:assert/strict'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RELEASE_TRUST_POLICY } from '../release-trust-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-trusted-ios-workflow.mjs')
const IOS_WORKFLOW = resolve(ROOT, '.github/workflows/ios-build.yml')
const V146_IOS_WORKFLOW_SHA256 =
  '52d711337b1a5376d14c22201ce581510e6950d86086ec8cd7f0f5ee5d62d4b0'

test('keeps the immutable v1.4.6 iOS workflow in the trusted allowlist', () => {
  assert.ok(
    RELEASE_TRUST_POLICY.iosBuildWorkflowSha256s.includes(
      V146_IOS_WORKFLOW_SHA256,
    ),
  )
})

function verify(sourceRoot) {
  return spawnSync(
    process.execPath,
    [VERIFIER, '--source-root', sourceRoot],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('accepts the exact trusted iOS workflow bytes', () => {
  const result = verify(ROOT)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('rejects changed or symlinked iOS workflow source', async (t) => {
  await t.test('changed bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'catgo-ios-workflow-'))
    try {
      const target = resolve(root, '.github/workflows/ios-build.yml')
      mkdirSync(dirname(target), { recursive: true })
      cpSync(IOS_WORKFLOW, target)
      writeFileSync(target, '# same name, different workflow\n')
      const result = verify(root)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /hash|trusted|workflow/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('symlink', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'catgo-ios-workflow-'))
    try {
      const target = resolve(root, '.github/workflows/ios-build.yml')
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(IOS_WORKFLOW, target)
      const result = verify(root)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /regular file|symbolic/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
