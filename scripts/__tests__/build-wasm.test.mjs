import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/build-wasm.mjs')
const VALID_LINE = '             valid targets: ferrox, chgdiff, catrender'

function runBuildWasm(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  })
}

function assertInvalidOnly(args) {
  const result = runBuildWasm(args)
  assert.equal(result.status, 2)
  assert.ok(result.stderr.split('\n').includes(VALID_LINE))
  assert.match(result.stderr, /invalid value for --only/)
  assert.doesNotMatch(result.stderr, /`wasm-pack` not found/)
}

const invalidCases = [
  ['missing spaced value', ['--only']],
  ['empty spaced value', ['--only', '']],
  ['unknown spaced value', ['--only', 'ferox']],
  ['empty equals value', ['--only=']],
  ['unknown equals value', ['--only=ferox']],
]

for (const [name, args] of invalidCases) {
  test(`rejects ${name} before tool preflight`, () => assertInvalidOnly(args))
}

const routedTargets = [
  [
    'ferrox',
    'ferrox scalar (@catgo/ferrox-wasm pkg-scalar), ' +
    'ferrox threaded (@catgo/ferrox-wasm pkg-threaded)',
  ],
  ['chgdiff', 'chgdiff'],
  ['catrender', 'catrender'],
]

for (const [target, pendingNames] of routedTargets) {
  for (const [form, args] of [
    ['spaced', ['--only', target]],
    ['equals', [`--only=${target}`]],
  ]) {
    test(`${form} selector routes only ${target}`, () => {
      const result = runBuildWasm(args)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /`wasm-pack` not found/)
      const pendingLine = result.stderr.split('\n').find((line) =>
        line.trimStart().startsWith('(')
      )
      assert.equal(pendingLine?.trim(), `(${pendingNames}).`)
      assert.doesNotMatch(result.stderr, /invalid value for --only/)
    })
  }
}
