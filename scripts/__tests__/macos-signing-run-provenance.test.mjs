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
const VERIFIER = resolve(ROOT, 'scripts/verify-macos-signing-run.mjs')
const TRUSTED_WORKFLOW = resolve(ROOT, '.github/workflows/tauri-build.yml')
const SOURCE_COMMIT = 'a'.repeat(40)
const RUN_ID = '123456789'
const MACOS_JOB = 'Build (macOS (Apple Silicon))'
const REQUIRED_STEPS = [
  'Verify macOS release signatures',
  'Upload macOS signing attestation',
]

function successfulJob() {
  return {
    id: 987654321,
    run_id: Number(RUN_ID),
    head_sha: SOURCE_COMMIT,
    name: MACOS_JOB,
    status: 'completed',
    conclusion: 'success',
    steps: REQUIRED_STEPS.map((name, index) => ({
      number: index + 1,
      name,
      status: 'completed',
      conclusion: 'success',
    })),
  }
}

function fixture(overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-macos-run-'))
  const attestation = {
    schemaVersion: 1,
    releaseTag: 'v1.4.6',
    sourceCommit: SOURCE_COMMIT,
    githubRunId: RUN_ID,
    signer: 'Developer ID Application: CatGo Project (ABCDEFGHIJ)',
    teamIdentifier: 'ABCDEFGHIJ',
    artifacts: [],
    ...overrides.attestation,
  }
  const run = {
    id: Number(RUN_ID),
    path: '.github/workflows/tauri-build.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: SOURCE_COMMIT,
    ...overrides.run,
  }
  const jobs = overrides.jobs ?? {
    total_count: 1,
    jobs: [successfulJob()],
  }
  const paths = {
    root,
    attestation: resolve(root, 'attestation.json'),
    run: resolve(root, 'run.json'),
    jobs: resolve(root, 'jobs.json'),
    targetWorkflow: resolve(root, 'tauri-build.yml'),
  }
  writeFileSync(paths.attestation, `${JSON.stringify(attestation)}\n`)
  writeFileSync(paths.run, `${JSON.stringify(run)}\n`)
  writeFileSync(paths.jobs, `${JSON.stringify([jobs])}\n`)
  copyFileSync(TRUSTED_WORKFLOW, paths.targetWorkflow)
  if (overrides.targetWorkflow) {
    writeFileSync(paths.targetWorkflow, overrides.targetWorkflow)
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
      '--target-workflow',
      paths.targetWorkflow,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

function withFixture(overrides, assertion) {
  const paths = fixture(overrides)
  try {
    assertion(verify(paths), paths)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
}

test('accepts the exact successful macOS release job from the pinned Tauri workflow', async (t) => {
  for (const event of ['push', 'workflow_dispatch']) {
    await t.test(event, () => {
      withFixture({ run: { event } }, (result) => {
        assert.equal(result.status, 0, result.stderr || result.stdout)
      })
    })
  }
})

test('rejects a run id, workflow path, source commit, or result outside the attestation', async (t) => {
  const failures = [
    [{ run: { id: 111111111 } }, /run id.*attestation/i],
    [
      { run: { path: '.github/workflows/forged-tauri-build.yml' } },
      /workflow.*tauri-build\.yml/i,
    ],
    [{ run: { head_sha: 'b'.repeat(40) } }, /head_sha.*source commit/i],
    [{ run: { conclusion: 'failure' } }, /conclusion.*success/i],
    [{ run: { event: 'schedule' } }, /push or workflow_dispatch/i],
  ]
  for (const [index, [overrides, message]] of failures.entries()) {
    await t.test(String(index), () => {
      withFixture(overrides, (result) => {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, message)
      })
    })
  }
})

test('rejects a missing, duplicate, failed, or cross-run macOS release job', async (t) => {
  const job = successfulJob()
  const failures = [
    [{ total_count: 0, jobs: [] }, /exactly one.*macOS.*job/i],
    [{ total_count: 2, jobs: [job, { ...job, id: 2 }] }, /exactly one.*macOS.*job/i],
    [
      {
        total_count: 1,
        jobs: [{ ...job, conclusion: 'failure' }],
      },
      /macOS.*job.*success/i,
    ],
    [
      {
        total_count: 1,
        jobs: [{ ...job, run_id: 111111111 }],
      },
      /macOS.*job.*run id/i,
    ],
    [
      {
        total_count: 1,
        jobs: [{ ...job, head_sha: 'b'.repeat(40) }],
      },
      /macOS.*job.*source commit/i,
    ],
  ]
  for (const [index, [jobs, message]] of failures.entries()) {
    await t.test(String(index), () => {
      withFixture({ jobs }, (result) => {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, message)
      })
    })
  }
})

test('rejects missing, skipped, failed, or duplicate signature proof steps', async (t) => {
  const mutations = [
    [
      (job) => {
        job.steps = job.steps.slice(1)
      },
      /Verify macOS release signatures.*exactly once/i,
    ],
    [
      (job) => {
        job.steps[0].conclusion = 'skipped'
      },
      /Verify macOS release signatures.*success/i,
    ],
    [
      (job) => {
        job.steps[1].conclusion = 'failure'
      },
      /Upload macOS signing attestation.*success/i,
    ],
    [
      (job) => {
        job.steps.push({ ...job.steps[1], number: 99 })
      },
      /Upload macOS signing attestation.*exactly once/i,
    ],
  ]
  for (const [index, [mutate, message]] of mutations.entries()) {
    await t.test(String(index), () => {
      const job = successfulJob()
      mutate(job)
      withFixture(
        { jobs: { total_count: 1, jobs: [job] } },
        (result) => {
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, message)
        },
      )
    })
  }
})

test('rejects a target tag that keeps step names but changes the trusted workflow', () => {
  const forged = readFileSync(TRUSTED_WORKFLOW, 'utf8').replace(
    'codesign --verify --deep --strict --verbose=2 "$app_path"',
    'true # forged no-op with the original step name',
  )
  assert.notEqual(forged, readFileSync(TRUSTED_WORKFLOW, 'utf8'))
  withFixture({ targetWorkflow: forged }, (result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /workflow SHA-256.*trusted release policy/i)
  })
})
