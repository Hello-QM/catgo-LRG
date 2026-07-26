import assert from 'node:assert/strict'
import {
  copyFileSync,
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
const VERIFIER = resolve(ROOT, 'scripts/verify-ios-testflight-run.mjs')
const IOS_WORKFLOW = resolve(ROOT, '.github/workflows/ios-build.yml')
const SOURCE_COMMIT = '06c02979b9e917011a63dcbfb09aaad7cfb9430d'
const RUN_HEAD_COMMIT = 'b'.repeat(40)
const RUN_ID = 123456789

function fixture(overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-ios-run-'))
  const attestation = {
    schemaVersion: 1,
    releaseTag: 'v1.4.6',
    sourceCommit: SOURCE_COMMIT,
    githubRunId: String(RUN_ID),
    status: 'accepted',
    ...overrides.attestation,
  }
  const run = {
    id: RUN_ID,
    path: '.github/workflows/ios-build.yml',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: SOURCE_COMMIT,
    head_branch: 'v1.4.6',
    ...overrides.run,
  }
  const jobs = {
    jobs: [
      {
        name: 'Build iOS app',
        run_id: RUN_ID,
        head_sha: overrides.run?.head_sha ?? SOURCE_COMMIT,
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Record exact release source',
            status: 'completed',
            conclusion: 'success',
          },
          {
            name: 'Upload to App Store Connect (TestFlight)',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
      {
        name: 'Attach TestFlight acceptance attestation',
        run_id: RUN_ID,
        head_sha: overrides.run?.head_sha ?? SOURCE_COMMIT,
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
  for (const job of jobs.jobs ?? []) {
    job.run_id ??= RUN_ID
    job.head_sha ??= run.head_sha
  }
  const paths = {
    root,
    attestation: resolve(root, 'attestation.json'),
    run: resolve(root, 'run.json'),
    jobs: resolve(root, 'jobs.json'),
    runWorkflow: resolve(root, 'ios-build.yml'),
  }
  writeFileSync(paths.attestation, `${JSON.stringify(attestation)}\n`)
  writeFileSync(paths.run, `${JSON.stringify(run)}\n`)
  writeFileSync(paths.jobs, `${JSON.stringify(jobs)}\n`)
  copyFileSync(IOS_WORKFLOW, paths.runWorkflow)
  if (overrides.runWorkflow) {
    writeFileSync(paths.runWorkflow, overrides.runWorkflow)
  }
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
      '--run-workflow',
      paths.runWorkflow,
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

test('accepts a trusted main-workflow run that checks out the exact release source', () => {
  withFixture(
    { run: { head_sha: RUN_HEAD_COMMIT, head_branch: 'main' } },
    (result) => {
      assert.equal(result.status, 0, result.stderr || result.stdout)
    },
  )
})

test('rejects a main backfill whose executed workflow bytes are not trusted', () => {
  withFixture(
    {
      run: { head_sha: RUN_HEAD_COMMIT, head_branch: 'main' },
      runWorkflow: '# forged iOS workflow\n',
    },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /workflow.*trusted|hash/i)
    },
  )
})

test('rejects a split-source backfill outside main', () => {
  withFixture(
    { run: { head_sha: RUN_HEAD_COMMIT, head_branch: 'release-helper' } },
    (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /head_sha.*source commit/i)
    },
  )
})

test('rejects iOS proof jobs from another run or head commit', async (t) => {
  for (const [index, mutation] of [
    { run_id: 987654321 },
    { head_sha: 'd'.repeat(40) },
  ].entries()) {
    await t.test(String(index), () => {
      const paths = fixture()
      try {
        const jobs = JSON.parse(readFileSync(paths.jobs, 'utf8'))
        Object.assign(jobs.jobs[0], mutation)
        writeFileSync(paths.jobs, `${JSON.stringify(jobs)}\n`)
        const result = verify(paths)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /mismatched provenance/i)
      } finally {
        rmSync(paths.root, { recursive: true, force: true })
      }
    })
  }
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
  await t.test('wrong attested source commit', () => {
    withFixture({ attestation: { sourceCommit: 'c'.repeat(40) } }, (result) => {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /attestation source commit/i)
    })
  })
})

test('rejects missing, skipped, or failed TestFlight proof steps', async (t) => {
  await t.test('missing exact-source proof', () => {
    const paths = fixture()
    try {
      const jobs = JSON.parse(readFileSync(paths.jobs, 'utf8'))
      jobs.jobs[0].steps = jobs.jobs[0].steps.filter(
        (step) => step.name !== 'Record exact release source',
      )
      writeFileSync(paths.jobs, `${JSON.stringify(jobs)}\n`)
      const result = verify(paths)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Record exact release source.*success/i)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })

  await t.test('missing TestFlight upload', () => {
    withFixture(
      {
        jobs: {
          jobs: [
            {
              name: 'Build iOS app',
              status: 'completed',
              conclusion: 'success',
              steps: [
                {
                  name: 'Record exact release source',
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
