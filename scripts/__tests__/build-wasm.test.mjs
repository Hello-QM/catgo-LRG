import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/build-wasm.mjs')

function runBuildWasm(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  })
}

function assertInvalidOnly(result) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid value for --only/)
  assert.match(result.stderr, /ferrox, chgdiff, catrender/)
}

test('rejects an unknown --only target and lists valid targets', () => {
  assertInvalidOnly(runBuildWasm(['--only', 'ferox']))
})

test('rejects a missing --only target and lists valid targets', () => {
  assertInvalidOnly(runBuildWasm(['--only']))
})
