import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/r2-release-mirror.yml'),
  'utf8',
)

test('blocks every R2 root publication until the exact TestFlight attestation passes', () => {
  const validate = WORKFLOW.indexOf(
    '- name: Validate release assets against target tag',
  )
  const iosGate = WORKFLOW.indexOf(
    'node scripts/verify-ios-testflight-attestation.mjs',
    validate,
  )
  const sync = WORKFLOW.indexOf('- name: Sync versioned release to R2')

  assert.ok(validate >= 0)
  assert.ok(iosGate > validate, 'iOS attestation is checked in target validation')
  assert.ok(sync > iosGate, 'R2 sync and root publication follow attestation')
  assert.match(
    WORKFLOW.slice(validate, sync),
    /source_commit=\$\(git rev-parse "\$tag\^\{commit\}"\)[\s\S]*verify-ios-testflight-attestation\.mjs[\s\S]*--tag "\$tag"[\s\S]*--source-commit "\$source_commit"[\s\S]*--assets-dir dist/,
  )
})
