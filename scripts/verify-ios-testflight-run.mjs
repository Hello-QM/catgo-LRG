#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const IOS_WORKFLOW_PATH = '.github/workflows/ios-build.yml'
const REQUIRED_PROOF = [
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
      !['--attestation', '--run', '--jobs', '--source-commit'].includes(key) ||
      !value
    ) {
      throw new Error(
        'Usage: verify-ios-testflight-run.mjs --attestation <json> ' +
          '--run <json> --jobs <json> --source-commit <40-hex-sha>',
      )
    }
    values.set(key, value)
  }
  for (const key of ['--attestation', '--run', '--jobs', '--source-commit']) {
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

function exactSuccessfulStep(jobs, expected) {
  const matchingJobs = jobs.filter((job) => job?.name === expected.job)
  if (
    matchingJobs.length !== 1 ||
    matchingJobs[0].status !== 'completed' ||
    matchingJobs[0].conclusion !== 'success'
  ) {
    throw new Error(`Required iOS job ${expected.job} must complete successfully`)
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
}) {
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
  if (run.head_sha !== sourceCommit) {
    throw new Error(
      `GitHub Actions run head_sha does not match source commit ${sourceCommit}`,
    )
  }
  if (attestation.sourceCommit !== sourceCommit) {
    throw new Error('TestFlight attestation source commit does not match release source')
  }
  for (const expected of REQUIRED_PROOF) exactSuccessfulStep(jobs, expected)
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
