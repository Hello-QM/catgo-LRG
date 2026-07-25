import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/build-wasm.mjs')
const VALID_LINE = '             valid targets: ferrox, chgdiff, catrender'

function runBuildWasm(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', ...env },
  })
}

function fakeWasmPack(t, { alwaysFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catgo-wasm-pack-'))
  const state = join(dir, 'attempts.txt')
  const script = join(dir, 'fake-wasm-pack.cjs')
  const executable = join(dir, process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack')

  writeFileSync(
    script,
    `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs')
if (process.argv[2] === '--version') process.exit(0)
const state = process.env.FAKE_WASM_PACK_STATE
let attempts = 0
try { attempts = Number(readFileSync(state, 'utf8')) } catch {}
attempts += 1
writeFileSync(state, String(attempts))
if (process.env.FAKE_WASM_PACK_WRITE_PACKAGE === '1') {
  const outIndex = process.argv.indexOf('--out-dir')
  const outDir = require('node:path').resolve(process.cwd(), process.argv[outIndex + 1])
  require('node:fs').mkdirSync(outDir, { recursive: true })
  require('node:fs').writeFileSync(
    require('node:path').join(outDir, 'package.json'),
    JSON.stringify({
      name: 'generated-wasm-package',
      files: ['generated.js', 'generated_bg.wasm'],
      license: '../../license'
    }, null, 2)
  )
}
if (process.env.FAKE_WASM_PACK_ALWAYS_FAIL === '1' || attempts === 1) {
  console.error('failed to download Binaryen')
  process.exit(73)
}
`,
  )
  if (process.platform === 'win32') {
    writeFileSync(executable, `@"${process.execPath}" "${script}" %*\r\n`)
  } else {
    writeFileSync(executable, readFileSync(script))
    chmodSync(executable, 0o755)
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  return {
    state,
    env: {
      PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      FAKE_WASM_PACK_STATE: state,
      FAKE_WASM_PACK_ALWAYS_FAIL: alwaysFail ? '1' : '0',
      CATGO_WASM_MAX_ATTEMPTS: '3',
      CATGO_WASM_RETRY_DELAY_MS: '0',
    },
  }
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

test('retries a failed wasm-pack target and succeeds on a later attempt', (t) => {
  const fake = fakeWasmPack(t)
  const result = runBuildWasm(['--only=chgdiff'], fake.env)

  assert.equal(result.status, 0)
  assert.equal(readFileSync(fake.state, 'utf8'), '2')
  assert.match(result.stderr, /retrying chgdiff \(attempt 2\/3\)/)
  assert.match(result.stdout, /all WASM extensions built/)
})

test('stops retrying wasm-pack after the configured attempt limit', (t) => {
  const fake = fakeWasmPack(t, { alwaysFail: true })
  const result = runBuildWasm(['--only=chgdiff'], fake.env)

  assert.equal(result.status, 73)
  assert.equal(readFileSync(fake.state, 'utf8'), '3')
  assert.match(result.stderr, /FAILED: chgdiff after 3 attempts/)
})

test('marks generated chgdiff and catrender npm manifests private', (t) => {
  const generated = [
    ['chgdiff', resolve(ROOT, 'src/lib/electronic/chgdiff-wasm-pkg')],
    ['catrender', resolve(ROOT, 'src/lib/structure/catrender/catrender-wasm-pkg')],
  ]
  t.after(() => {
    for (const [, dir] of generated) rmSync(dir, { recursive: true, force: true })
  })

  for (const [target, dir] of generated) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const fake = fakeWasmPack(t)
    const result = runBuildWasm([`--only=${target}`], {
      ...fake.env,
      FAKE_WASM_PACK_WRITE_PACKAGE: '1',
    })
    assert.equal(result.status, 0)
    const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.private, true, target)
    assert.equal(manifest.license, 'LicenseRef-CatGo-Noncommercial-1.0', target)
  }
})
