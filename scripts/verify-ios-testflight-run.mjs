#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { RELEASE_TRUST_POLICY } from './release-trust-policy.mjs'

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const IOS_WORKFLOW_PATH = '.github/workflows/ios-build.yml'
const V146_TAG = 'v1.4.6'
const V146_SOURCE_COMMIT = '06c02979b9e917011a63dcbfb09aaad7cfb9430d'
const V146_BACKFILL_BRANCH = 'main'
const REQUIRED_PROOF = [
  {
    job: 'Build iOS app',
    step: 'Record exact release source',
  },
  {
    job: 'Build iOS app',
    step: 'Upload to App Store Connect (TestFlight)',
  },
  {
    job: 'Attach TestFlight acceptance attestation',
    step: 'Upload accepted TestFlight attestation',
  },
]

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      ![
        '--attestation',
        '--run',
        '--jobs',
        '--source-commit',
        '--run-workflow',
      ].includes(key) ||
      !value
    ) {
      throw new Error(
        'Usage: verify-ios-testflight-run.mjs --attestation <json> ' +
          '--run <json> --jobs <json> --source-commit <40-hex-sha> ' +
          '--run-workflow <ios-build.yml>',
      )
    }
    values.set(key, value)
  }
  for (const key of [
    '--attestation',
    '--run',
    '--jobs',
    '--source-commit',
    '--run-workflow',
  ]) {
    if (!values.has(key)) throw new Error(`Missing required argument: ${key}`)
  }
  const sourceCommit = values.get('--source-commit')
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('Expected source commit must be an exact lowercase 40-hex SHA')
  }
  return {
    attestationPath: resolve(values.get('--attestation')),
    runPath: resolve(values.get('--run')),
    jobsPath: resolve(values.get('--jobs')),
    sourceCommit,
    runWorkflowPath: resolve(values.get('--run-workflow')),
  }
}

function readJsonFile(path, kind) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${kind} must be a regular file`)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${kind} is invalid JSON: ${error.message}`)
  }
}

function trustedRunWorkflowHash(path) {
  const metadata = lstatSync(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 512 * 1024
  ) {
    throw new Error('Executed iOS workflow must be a small regular file')
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  const approved = RELEASE_TRUST_POLICY.iosBuildWorkflowSha256s
  if (
    !Array.isArray(approved) ||
    approved.length === 0 ||
    approved.some((digest) => !SHA256_PATTERN.test(digest)) ||
    !approved.includes(actual)
  ) {
    throw new Error('Executed iOS workflow hash is not trusted')
  }
  return actual
}

function exactSuccessfulStep(jobs, expected, run) {
  const matchingJobs = jobs.filter((job) => job?.name === expected.job)
  if (
    matchingJobs.length !== 1 ||
    matchingJobs[0].status !== 'completed' ||
    matchingJobs[0].conclusion !== 'success'
  ) {
    throw new Error(`Required iOS job ${expected.job} must complete successfully`)
  }
  if (
    String(matchingJobs[0].run_id) !== String(run.id) ||
    matchingJobs[0].head_sha !== run.head_sha
  ) {
    throw new Error(`Required iOS job ${expected.job} has mismatched provenance`)
  }
  const matchingSteps = (matchingJobs[0].steps ?? []).filter(
    (step) => step?.name === expected.step,
  )
  if (
    matchingSteps.length !== 1 ||
    matchingSteps[0].status !== 'completed' ||
    matchingSteps[0].conclusion !== 'success'
  ) {
    throw new Error(`Required iOS step ${expected.step} must complete with success`)
  }
}

function verifyRunProvenance({
  attestationPath,
  runPath,
  jobsPath,
  sourceCommit,
  runWorkflowPath,
}) {
  const runWorkflowHash = trustedRunWorkflowHash(runWorkflowPath)
  const attestation = readJsonFile(attestationPath, 'TestFlight attestation')
  const run = readJsonFile(runPath, 'GitHub Actions run')
  const jobsDocument = readJsonFile(jobsPath, 'GitHub Actions jobs')
  const jobs = Array.isArray(jobsDocument)
    ? jobsDocument.flatMap((page) => page?.jobs ?? [])
    : jobsDocument?.jobs

  if (!Array.isArray(jobs)) {
    throw new Error('GitHub Actions jobs response has no jobs array')
  }
  if (String(run.id) !== attestation.githubRunId) {
    throw new Error(
      `GitHub Actions run id ${String(run.id)} does not match attestation ` +
        `${String(attestation.githubRunId)}`,
    )
  }
  if (run.path !== IOS_WORKFLOW_PATH) {
    throw new Error(`GitHub Actions workflow must be exactly ${IOS_WORKFLOW_PATH}`)
  }
  if (
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    throw new Error(
      'GitHub Actions run must be a completed workflow_dispatch with conclusion success',
    )
  }
  if (attestation.sourceCommit !== sourceCommit) {
    throw new Error('TestFlight attestation source commit does not match release source')
  }
  if (run.head_sha !== sourceCommit) {
    if (
      attestation.releaseTag !== V146_TAG ||
      sourceCommit !== V146_SOURCE_COMMIT ||
      run.head_branch !== V146_BACKFILL_BRANCH ||
      runWorkflowHash !== RELEASE_TRUST_POLICY.iosBackfillWorkflowSha256
    ) {
      throw new Error(
        `GitHub Actions run head_sha does not match source commit ${sourceCommit}`,
      )
    }
  }
  for (const expected of REQUIRED_PROOF) {
    exactSuccessfulStep(jobs, expected, run)
  }
  return { runId: attestation.githubRunId, sourceCommit }
}

try {
  const result = verifyRunProvenance(parseArguments(process.argv.slice(2)))
  process.stdout.write(
    `[ios-run] verified run ${result.runId} for ${result.sourceCommit}\n`,
  )
} catch (error) {
  process.stderr.write(`[ios-run] ${error.message}\n`)
  process.exitCode = 1
}
