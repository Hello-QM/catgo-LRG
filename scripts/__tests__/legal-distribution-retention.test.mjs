import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { legalBundleSources } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'

const REQUIRED_FILES = [
  ...legalBundleSources(),
  'ACKNOWLEDGEMENT.txt',
]

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
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('release verifier discovers and proves every application distribution class', () => {
  const result = runNode('scripts/verify-legal-distributions.mjs', ['--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.classes, DISTRIBUTION_CLASSES)
  assert.equal(report.acknowledgement, ACK)
  assert.equal(report.requiredFiles, REQUIRED_FILES.length)
})
