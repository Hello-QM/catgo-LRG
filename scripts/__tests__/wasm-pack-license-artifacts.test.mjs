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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

let cleanupWasmPackLicenseArtifacts
try {
  ;({ cleanupWasmPackLicenseArtifacts } = await import(
    '../cleanup-wasm-pack-license-artifacts.mjs'
  ))
} catch {
  cleanupWasmPackLicenseArtifacts = undefined
}

const ARTIFACTS = [
  'extensions/license',
  'src/lib/license',
  'src/lib/structure/license',
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'catgo-wasm-license-'))
  const license = 'CatGo test license\n'
  writeFileSync(join(root, 'license'), license)
  for (const relativePath of ARTIFACTS) {
    const path = join(root, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, license)
  }
  return root
}

test('removes only the three byte-identical wasm-pack license artifacts', (t) => {
  assert.equal(
    typeof cleanupWasmPackLicenseArtifacts,
    'function',
    'the build exposes a safe cleanup function',
  )
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const unrelated = join(root, 'src/lib/unrelated.txt')
  writeFileSync(unrelated, 'keep me\n')

  const removed = cleanupWasmPackLicenseArtifacts(root)

  assert.deepEqual(removed, ARTIFACTS)
  for (const relativePath of ARTIFACTS) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath)
  }
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep me\n')
})

test('refuses cleanup atomically when an artifact differs from the root license', (t) => {
  assert.equal(typeof cleanupWasmPackLicenseArtifacts, 'function')
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mismatched = join(root, ARTIFACTS[1])
  writeFileSync(mismatched, 'user-owned content\n')

  assert.throws(
    () => cleanupWasmPackLicenseArtifacts(root),
    /Refusing to remove unexpected wasm-pack license artifact/,
  )
  for (const relativePath of ARTIFACTS) {
    assert.equal(existsSync(join(root, relativePath)), true, relativePath)
  }
  assert.equal(readFileSync(mismatched, 'utf8'), 'user-owned content\n')
})

test('refuses a symlinked artifact without removing any candidate', (t) => {
  assert.equal(typeof cleanupWasmPackLicenseArtifacts, 'function')
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const symlinked = join(root, ARTIFACTS[2])
  rmSync(symlinked)
  symlinkSync(join(root, 'license'), symlinked)

  assert.throws(
    () => cleanupWasmPackLicenseArtifacts(root),
    /Refusing to remove non-regular wasm-pack license artifact/,
  )
  for (const relativePath of ARTIFACTS) {
    assert.equal(existsSync(join(root, relativePath)), true, relativePath)
  }
})
