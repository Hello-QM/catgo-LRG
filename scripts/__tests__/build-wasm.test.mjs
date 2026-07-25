import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/build-wasm.mjs')
const VALID_LINE = '             valid targets: ferrox, chgdiff, catrender'
const GENERATED_OUTPUTS = [
  resolve(ROOT, 'extensions/rust-wasm/pkg-scalar'),
  resolve(ROOT, 'extensions/rust-wasm/pkg'),
  resolve(ROOT, 'extensions/rust-wasm/pkg-legacy'),
  resolve(ROOT, 'extensions/rust-wasm/pkg-threaded'),
  resolve(ROOT, 'src/lib/electronic/chgdiff-wasm-pkg'),
  resolve(ROOT, 'src/lib/structure/catrender/catrender-wasm-pkg'),
]
const REPO_MUTATED_PATHS = [
  ...GENERATED_OUTPUTS,
  resolve(ROOT, 'extensions/license'),
  resolve(ROOT, 'src/lib/license'),
  resolve(ROOT, 'src/lib/structure/license'),
]

function lstatIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function snapshotPaths(paths) {
  const backupRoot = mkdtempSync(join(tmpdir(), 'catgo-wasm-output-snapshot-'))
  const entries = paths.map((path, index) => {
    const backup = join(backupRoot, String(index))
    const present = lstatIfPresent(path) !== null
    if (present) {
      cpSync(path, backup, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      })
    }
    return { path, backup, present }
  })
  return { backupRoot, entries }
}

function restorePaths(snapshot) {
  try {
    for (const { path, backup, present } of snapshot.entries) {
      rmSync(path, { recursive: true, force: true })
      if (present) {
        mkdirSync(dirname(path), { recursive: true })
        cpSync(backup, path, {
          recursive: true,
          force: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        })
      }
    }
  } finally {
    rmSync(snapshot.backupRoot, { recursive: true, force: true })
  }
}

function treeSignature(root) {
  const signature = []
  function visit(path, relative) {
    const info = lstatSync(path)
    if (info.isDirectory()) {
      signature.push(['directory', relative])
      for (const name of readdirSync(path).sort()) {
        visit(resolve(path, name), join(relative, name))
      }
    } else if (info.isSymbolicLink()) {
      signature.push(['symlink', relative, readlinkSync(path)])
    } else {
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      signature.push(['file', relative, digest])
    }
  }
  visit(root, '.')
  return signature
}

const initialRepoState = snapshotPaths(REPO_MUTATED_PATHS)
after(() => restorePaths(initialRepoState))

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
if (process.env.FAKE_WASM_PACK_LICENSE_ARTIFACT) {
  const fs = require('node:fs')
  const path = require('node:path')
  fs.mkdirSync(path.dirname(process.env.FAKE_WASM_PACK_LICENSE_ARTIFACT), {
    recursive: true
  })
  fs.copyFileSync(
    process.env.FAKE_ROOT_LICENSE,
    process.env.FAKE_WASM_PACK_LICENSE_ARTIFACT
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

if (process.env.CATGO_BUILD_WASM_PRESERVATION_CHILD !== '1') {
  test('preserves every pre-existing generated output byte-for-byte', () => {
    const initial = snapshotPaths(GENERATED_OUTPUTS)
    try {
      for (const [index, dir] of GENERATED_OUTPUTS.entries()) {
        mkdirSync(resolve(dir, 'nested'), { recursive: true })
        writeFileSync(
          resolve(dir, 'nested', 'sentinel.bin'),
          Buffer.from([0, 255, index, 10, 13, 42]),
        )
      }
      const expected = GENERATED_OUTPUTS.map((path) => treeSignature(path))
      const childEnv = { ...process.env }
      delete childEnv.NODE_TEST_CONTEXT

      const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
        encoding: 'utf8',
        env: {
          ...childEnv,
          CATGO_BUILD_WASM_PRESERVATION_CHILD: '1',
        },
      })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      for (const [index, path] of GENERATED_OUTPUTS.entries()) {
        assert.deepEqual(treeSignature(path), expected[index], path)
      }
    } finally {
      restorePaths(initial)
    }
  })
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

test('removes the license artifact emitted by wasm-pack outside its output directory', (t) => {
  const artifact = resolve(ROOT, 'src/lib/license')
  rmSync(artifact, { force: true })
  t.after(() => rmSync(artifact, { force: true }))
  const fake = fakeWasmPack(t)

  const result = runBuildWasm(['--only=chgdiff'], {
    ...fake.env,
    FAKE_ROOT_LICENSE: resolve(ROOT, 'license'),
    FAKE_WASM_PACK_LICENSE_ARTIFACT: artifact,
  })

  assert.equal(result.status, 0)
  assert.equal(existsSync(artifact), false)
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

test('hardens Ferrox scalar, legacy, and threaded generated npm manifests', (t) => {
  const generated = [
    resolve(ROOT, 'extensions/rust-wasm/pkg-scalar'),
    resolve(ROOT, 'extensions/rust-wasm/pkg'),
    resolve(ROOT, 'extensions/rust-wasm/pkg-threaded'),
  ]
  t.after(() => {
    for (const dir of generated) rmSync(dir, { recursive: true, force: true })
  })
  for (const dir of generated) rmSync(dir, { recursive: true, force: true })

  const fake = fakeWasmPack(t)
  const result = runBuildWasm(['--only=ferrox'], {
    ...fake.env,
    FAKE_WASM_PACK_WRITE_PACKAGE: '1',
  })
  assert.equal(result.status, 0)

  const manifests = generated.map((dir) =>
    JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  )
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.private, true, generated[index])
    assert.equal(
      manifest.license,
      'LicenseRef-CatGo-Noncommercial-1.0',
      generated[index],
    )
  }
  assert.deepEqual(manifests[1], manifests[0], 'pkg remains the scalar compatibility copy')
})
