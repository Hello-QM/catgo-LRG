import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-testflight-upload-result.mjs')

function verify(exitCode, output) {
  return spawnSync(
    process.execPath,
    [VERIFIER, '--exit-code', String(exitCode)],
    { encoding: 'utf8', input: output },
  )
}

test('accepts only a zero exit with the explicit altool success marker', () => {
  const result = verify(0, 'No errors uploading\nUPLOAD SUCCEEDED\n')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /accepted/i)
})

test('rejects a zero exit with empty or unfamiliar output', async (t) => {
  for (const [name, output] of [
    ['empty', ''],
    ['unfamiliar', 'Upload request completed\n'],
  ]) {
    await t.test(name, () => {
      const result = verify(0, output)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /missing explicit UPLOAD SUCCEEDED/i)
    })
  }
})

test('rejects failure markers even when a success marker and zero exit are present', () => {
  const result = verify(
    0,
    'UPLOAD SUCCEEDED\nERROR: package validation failed\n',
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /failure marker/i)
})

test('rejects a nonzero altool exit even when output claims success', () => {
  const result = verify(1, 'UPLOAD SUCCEEDED\n')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exit code 1/i)
})
