#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { RELEASE_TRUST_POLICY } from './release-trust-policy.mjs'

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const RUN_ID_PATTERN = /^[1-9]\d*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TAURI_WORKFLOW_PATH = '.github/workflows/tauri-build.yml'
const MACOS_JOB_NAME = 'Build (macOS (Apple Silicon))'
const LINUX_JOB_NAME = 'Build (Linux)'
const WINDOWS_JOB_NAME = 'Build (Windows)'
const V146_TAG = 'v1.4.6'
const V146_SOURCE_COMMIT = '06c02979b9e917011a63dcbfb09aaad7cfb9430d'
const V146_RUN_ID = '30209332584'
const V146_WINDOWS_FAILURE_STEP = 'Verify release rights'
const REQUIRED_STEPS = [
  'Verify macOS release signatures',
  'Upload macOS signing attestation',
]
const ARGUMENTS = new Set([
  '--attestation',
  '--run',
  '--jobs',
  '--source-commit',
  '--target-workflow',
])

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!ARGUMENTS.has(argument) || !value || values.has(argument)) {
      throw new Error(
        'Usage: verify-macos-signing-run.mjs --attestation <json> ' +
          '--run <json> --jobs <json> --source-commit <40-hex-sha> ' +
          '--target-workflow <tauri-build.yml>',
      )
    }
    values.set(argument, value)
    index += 1
  }
  for (const argument of ARGUMENTS) {
    if (!values.has(argument)) {
      throw new Error(`Missing required argument: ${argument}`)
    }
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
    targetWorkflowPath: resolve(values.get('--target-workflow')),
  }
}

function readRegularFile(path, kind, maxSize) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${kind} must be a regular file`)
  }
  if (metadata.size > maxSize) {
    throw new Error(`${kind} is unexpectedly large`)
  }
  return readFileSync(path)
}

function readJsonFile(path, kind) {
  try {
    return JSON.parse(readRegularFile(path, kind, 4 * 1024 * 1024))
  } catch (error) {
    throw new Error(`${kind} is invalid JSON: ${error.message}`)
  }
}

function verifyWorkflowHash(path) {
  const approved = RELEASE_TRUST_POLICY.tauriReleaseWorkflowSha256s
  if (
    !Array.isArray(approved) ||
    approved.length === 0 ||
    approved.some((digest) => !SHA256_PATTERN.test(digest))
  ) {
    throw new Error(
      'Trusted release policy has no valid Tauri workflow SHA-256 allowlist',
    )
  }
  const contents = readRegularFile(path, 'Target Tauri workflow', 512 * 1024)
  const actual = createHash('sha256').update(contents).digest('hex')
  if (!approved.includes(actual)) {
    throw new Error(
      'Target Tauri workflow SHA-256 does not match the trusted release policy',
    )
  }
}

function jobsFromDocument(document) {
  const jobs = Array.isArray(document)
    ? document.flatMap((page) => page?.jobs ?? [])
    : document?.jobs
  if (!Array.isArray(jobs)) {
    throw new Error('GitHub Actions jobs response has no jobs array')
  }
  return jobs
}

function verifySuccessfulStep(job, name) {
  const steps = (job.steps ?? []).filter((step) => step?.name === name)
  if (steps.length !== 1) {
    throw new Error(`Required macOS step ${name} must appear exactly once`)
  }
  if (
    steps[0].status !== 'completed' ||
    steps[0].conclusion !== 'success'
  ) {
    throw new Error(`Required macOS step ${name} must complete with success`)
  }
}

function verifyMacosJob(jobs, runId, sourceCommit) {
  const matching = jobs.filter((job) => job?.name === MACOS_JOB_NAME)
  if (matching.length !== 1) {
    throw new Error('Expected exactly one macOS release job')
  }
  const job = matching[0]
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    throw new Error('The macOS release job must complete with success')
  }
  if (String(job.run_id) !== runId) {
    throw new Error('The macOS release job run id does not match the attestation')
  }
  if (job.head_sha !== sourceCommit) {
    throw new Error('The macOS release job source commit does not match')
  }
  for (const name of REQUIRED_STEPS) verifySuccessfulStep(job, name)
}

function verifyKnownV146WindowsPreflightFailure({
  attestation,
  run,
  jobs,
  runId,
  sourceCommit,
}) {
  if (
    attestation.releaseTag !== V146_TAG ||
    sourceCommit !== V146_SOURCE_COMMIT ||
    runId !== V146_RUN_ID ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure'
  ) {
    return false
  }

  const expectedNames = [MACOS_JOB_NAME, LINUX_JOB_NAME, WINDOWS_JOB_NAME]
  if (
    jobs.length !== expectedNames.length ||
    expectedNames.some(
      (name) => jobs.filter((job) => job?.name === name).length !== 1,
    )
  ) {
    throw new Error(
      'Known v1.4.6 partial failure must contain exactly the macOS, Linux, and Windows jobs',
    )
  }
  for (const job of jobs) {
    if (
      job.status !== 'completed' ||
      String(job.run_id) !== runId ||
      job.head_sha !== sourceCommit
    ) {
      throw new Error(
        'Known v1.4.6 partial-failure job identity does not match the release run',
      )
    }
  }

  verifyMacosJob(jobs, runId, sourceCommit)
  const linux = jobs.find((job) => job.name === LINUX_JOB_NAME)
  if (linux.conclusion !== 'success') {
    throw new Error('Known v1.4.6 Linux release job must complete with success')
  }

  const windows = jobs.find((job) => job.name === WINDOWS_JOB_NAME)
  if (windows.conclusion !== 'failure') {
    throw new Error('Known v1.4.6 Windows release job must be the failed job')
  }
  const failedSteps = jobs.flatMap((job) =>
    (job.steps ?? []).filter((step) => step?.conclusion === 'failure'),
  )
  if (
    failedSteps.length !== 1 ||
    failedSteps[0].name !== V146_WINDOWS_FAILURE_STEP ||
    failedSteps[0].status !== 'completed'
  ) {
    throw new Error(
      'Known v1.4.6 run must fail only at the Windows release-rights preflight',
    )
  }
  const failureIndex = windows.steps.findIndex(
    (step) => step?.name === V146_WINDOWS_FAILURE_STEP,
  )
  for (const step of windows.steps.slice(failureIndex + 1)) {
    const allowedEpilogue =
      (step.name?.startsWith('Post ') || step.name === 'Complete job') &&
      step.conclusion === 'success'
    if (step.conclusion !== 'skipped' && !allowedEpilogue) {
      throw new Error(
        'Known v1.4.6 Windows build and upload steps after the preflight must be skipped',
      )
    }
  }
  return true
}

function verifyRunProvenance({
  attestationPath,
  runPath,
  jobsPath,
  sourceCommit,
  targetWorkflowPath,
}) {
  verifyWorkflowHash(targetWorkflowPath)
  const attestation = readJsonFile(
    attestationPath,
    'macOS signing attestation',
  )
  const run = readJsonFile(runPath, 'GitHub Actions run')
  const jobs = jobsFromDocument(
    readJsonFile(jobsPath, 'GitHub Actions jobs'),
  )
  if (
    typeof attestation.githubRunId !== 'string' ||
    !RUN_ID_PATTERN.test(attestation.githubRunId)
  ) {
    throw new Error('macOS signing attestation has an invalid GitHub run id')
  }
  if (attestation.sourceCommit !== sourceCommit) {
    throw new Error('macOS signing attestation source commit does not match')
  }
  if (String(run.id) !== attestation.githubRunId) {
    throw new Error('GitHub Actions run id does not match the attestation')
  }
  if (run.path !== TAURI_WORKFLOW_PATH) {
    throw new Error(
      `GitHub Actions workflow must be exactly ${TAURI_WORKFLOW_PATH}`,
    )
  }
  if (run.event !== 'push' && run.event !== 'workflow_dispatch') {
    throw new Error(
      'GitHub Actions run event must be push or workflow_dispatch',
    )
  }
  if (run.status !== 'completed') {
    throw new Error('GitHub Actions run must be completed')
  }
  if (run.head_sha !== sourceCommit) {
    throw new Error(
      'GitHub Actions run head_sha does not match the source commit',
    )
  }
  if (run.conclusion === 'success') {
    verifyMacosJob(jobs, attestation.githubRunId, sourceCommit)
  } else if (
    !verifyKnownV146WindowsPreflightFailure({
      attestation,
      run,
      jobs,
      runId: attestation.githubRunId,
      sourceCommit,
    })
  ) {
    throw new Error(
      'GitHub Actions run must complete with success or match the exact v1.4.6 Windows rights-preflight exception',
    )
  }
  return { runId: attestation.githubRunId, sourceCommit }
}

try {
  const result = verifyRunProvenance(
    parseArguments(process.argv.slice(2)),
  )
  process.stdout.write(
    `[macos-run] verified run ${result.runId} for ${result.sourceCommit}\n`,
  )
} catch (error) {
  process.stderr.write(`[macos-run] ${error.message}\n`)
  process.exitCode = 1
}
