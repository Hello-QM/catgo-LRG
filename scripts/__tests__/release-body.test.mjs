import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TAG = 'v1.4.7'
const NOTES = resolve(ROOT, `.github/release-notes/${TAG}.md`)
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/tauri-build.yml'),
  'utf8',
)

function runEnsure({ existing, createStatus = 0, tag = TAG }) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-release-body-'))
  const fakeGh = resolve(fixture, 'gh')
  const state = resolve(fixture, 'release-exists')
  const log = resolve(fixture, 'gh.log')
  if (existing) writeFileSync(state, 'exists\n')
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  [ -f "$GH_STATE" ]
  exit
fi
if [ "$1 $2" = "release create" ]; then
  : > "$GH_STATE"
  exit "\${GH_CREATE_STATUS:-0}"
fi
exit 0
`,
  )
  chmodSync(fakeGh, 0o755)
  const result = spawnSync(
    'bash',
    [resolve(ROOT, 'scripts/ensure-release-body.sh'), tag],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CATGO_GH_BIN: fakeGh,
        GH_LOG: log,
        GH_STATE: state,
        GH_CREATE_STATUS: String(createStatus),
      },
    },
  )
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  rmSync(fixture, { recursive: true, force: true })
  return { result, calls }
}

test('canonical current release body contains every mandatory disclosure', () => {
  assert.ok(existsSync(NOTES), 'canonical release notes file exists')
  const body = readFileSync(NOTES, 'utf8')
  assert.match(body, /AGPL-3\.0-or-later/)
  assert.doesNotMatch(body,
    /CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial|COMMERCIAL_LICENSE|prior written commercial permission/i)
  assert.match(body, /This work used CatGo \(https:\/\/catgo-ucsd\.org\)\./)
  assert.match(body, /10\.26434\/chemrxiv\.15002984\/v1/)
  assert.match(body, /please include this acknowledgement/i)
  assert.match(body, /not an additional condition/i)
})

test('existing release is always edited to the canonical body', () => {
  const { result, calls } = runEnsure({ existing: true })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(calls, /^release view v1\.4\.7$/m)
  assert.doesNotMatch(calls, /^release create /m)
  assert.match(
    calls,
    /^release edit v1\.4\.7 --title CatGo v1\.4\.7 --notes-file \.github\/release-notes\/v1\.4\.7\.md$/m,
  )
})

test('concurrent draft creation still converges through an explicit edit', () => {
  const { result, calls } = runEnsure({
    existing: false,
    createStatus: 1,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(calls, /^release create v1\.4\.7 --draft /m)
  assert.match(calls, /^release view v1\.4\.7$/m)
  assert.match(calls, /^release edit v1\.4\.7 /m)
})

test('Tauri workflow finalizes the canonical body after tauri-action', () => {
  const action = WORKFLOW.indexOf('uses: tauri-apps/tauri-action@v0.6')
  const finalize = WORKFLOW.indexOf('- name: Finalize canonical release body')
  assert.ok(action >= 0)
  assert.ok(finalize > action)
  const block = WORKFLOW.slice(finalize)
  assert.match(block, /if: env\.CATGO_RELEASE_TAG == 'v1\.4\.7'/)
  assert.match(block, /scripts\/ensure-release-body\.sh "\$CATGO_RELEASE_TAG"/)
})

test('Tauri workflow retains the v1.4.6 backfill finalizer', () => {
  assert.match(
    WORKFLOW,
    /if: env\.CATGO_RELEASE_TAG == 'v1\.4\.6'[\s\S]*scripts\/ensure-v1\.4\.6-release-body\.sh "\$CATGO_RELEASE_TAG"/,
  )
})

test('canonical body finalizer rejects malformed release tags before calling GitHub', () => {
  const { result, calls } = runEnsure({
    existing: false,
    tag: 'latest',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /release tag must match vX\.Y\.Z/)
  assert.equal(calls, '')
})
