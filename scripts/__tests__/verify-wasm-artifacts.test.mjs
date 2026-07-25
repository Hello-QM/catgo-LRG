import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-wasm-artifacts.mjs')
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

function writeArtifact(dir, glue) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ferrox.js'), glue)
  writeFileSync(join(dir, 'ferrox_bg.wasm'), WASM_HEADER)
  writeFileSync(join(dir, 'ferrox.d.ts'), 'export {}\n')
}

test('reports missing, extra, and byte-mismatched bridge files together', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'catgo-wasm-verifier-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const scriptDir = join(root, 'scripts')
  const wasmRoot = join(root, 'extensions', 'rust-wasm')
  const scalarDir = join(wasmRoot, 'pkg-scalar')
  const bridgeDir = join(wasmRoot, 'pkg')
  mkdirSync(scriptDir, { recursive: true })
  copyFileSync(VERIFIER, join(scriptDir, 'verify-wasm-artifacts.mjs'))

  writeArtifact(scalarDir, 'export default function init() {}\n')
  writeArtifact(bridgeDir, 'export default function init() {}\n')
  writeArtifact(
    join(wasmRoot, 'pkg-threaded'),
    'export function initThreadPool() {}\n',
  )
  writeFileSync(join(scalarDir, 'missing.txt'), 'scalar only\n')
  writeFileSync(join(bridgeDir, 'extra.txt'), 'bridge only\n')
  writeFileSync(join(scalarDir, 'mismatch.txt'), 'scalar bytes\n')
  writeFileSync(join(bridgeDir, 'mismatch.txt'), 'bridge bytes\n')

  const result = spawnSync(
    process.execPath,
    [join(scriptDir, 'verify-wasm-artifacts.mjs')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /file set differs from pkg-scalar\/ — missing: missing\.txt; extra: extra\.txt/,
  )
  assert.match(
    result.stderr,
    /differs byte-for-byte from pkg-scalar\/: mismatch\.txt/,
  )
})
