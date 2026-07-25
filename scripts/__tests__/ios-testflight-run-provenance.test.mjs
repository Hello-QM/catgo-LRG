import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-ios-testflight-run.mjs')
const SOURCE_COMMIT = 'a'.repeat(40)

function fixture(overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-ios-run-'))
  const attestation = {
    schemaVersion: 1,
    releaseTag: 'v1.4.6',
    sourceCommit: SOURCE_COMMIT,
    githubRunId: '123456789',
    status: 'accepted',
    ...overrides.attestation,
  }
  const run = {
    id: 123456789,
    path: '.github/workflows/ios-build.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: SOURCE_COMMIT,
    ...overrides.run,
  }
  const jobs = {
    jobs: [
      {
        name: 'Build iOS app',
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Upload to App Store Connect (TestFlight)',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
      {
        name: 'Attach TestFlight acceptance attestation',
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Upload accepted TestFlight attestation',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    ],
    ...overrides.jobs,
  }
  const paths = {
    root,
    attestation: resolve(root, 'attestation.json'),
    run: resolve(root, 'run.json'),
    jobs: resolve(root, 'jobs.json'),
  }
  writeFileSync(paths.attestation, `${JSON.stringify(attestation)}\n`)
  writeFileSync(paths.run, `${JSON.stringify(run)}\n`)
  writeFileSync(paths.jobs, `${JSON.stringify(jobs)}\n`)
  return paths
}

function verify(paths) {
  return spawnSync(
    process.execPath,
    [
      VERIFIER,
      '--attestation',
      paths.attestation,
      '--run',
      paths.run,
      '--jobs',
      paths.jobs,
      '--source-commit',
      SOURCE_COMMIT,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

function withFixture(overrides, assertion) {
  const paths = fixture(overrides)
  try {
    assertion(verify(paths))
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
}

test('accepts a successful ios-build run bound to the attested source commit', () => {
  withFixture({}, (result) => {
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

test('rejects a run id that does not match the attestation', () => {
  withFixture({ run: { id: 987654321 } }, (result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /run id.*attestation/i)
  })
})

test('rejects a successful run from any workflow other than ios-build', () => {
  withFixture(
    { run: { path: '.github/workflows/forged-ios-build.yml' } },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /workflow.*ios-build\.yml/i)
    },
  )
})

test('rejects a run whose conclusion or source commit is not exact', async (t) => {
  await t.test('failed conclusion', () => {
    withFixture({ run: { conclusion: 'failure' } }, (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /conclusion.*success/i)
    })
  })
  await t.test('wrong source commit', () => {
    withFixture({ run: { head_sha: 'b'.repeat(40) } }, (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /head_sha.*source commit/i)
    })
  })
})

test('rejects missing, skipped, or failed TestFlight proof steps', async (t) => {
  await t.test('missing TestFlight upload', () => {
    withFixture(
      {
        jobs: {
          jobs: [
            {
              name: 'Build iOS app',
              status: 'completed',
              conclusion: 'success',
              steps: [],
            },
            {
              name: 'Attach TestFlight acceptance attestation',
              status: 'completed',
              conclusion: 'success',
              steps: [
                {
                  name: 'Upload accepted TestFlight attestation',
                  status: 'completed',
                  conclusion: 'success',
                },
              ],
            },
          ],
        },
      },
      (result) => {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /Upload to App Store Connect.*success/i)
      },
    )
  })

  await t.test('failed attestation publication', () => {
    const paths = fixture()
    try {
      const jobs = JSON.parse(readFileSync(paths.jobs, 'utf8'))
      jobs.jobs[1].steps[0].conclusion = 'failure'
      writeFileSync(paths.jobs, `${JSON.stringify(jobs)}\n`)
      const result = verify(paths)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Upload accepted TestFlight attestation.*success/i)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })
})
