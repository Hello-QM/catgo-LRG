#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TAG_PATTERN = /^v\d+\.\d+\.\d+$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const RUN_ID_PATTERN = /^[1-9]\d*$/
const SCHEMA_KEYS = [
  'githubRunId',
  'releaseTag',
  'schemaVersion',
  'sourceCommit',
  'status',
]

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (
      !['--tag', '--source-commit', '--assets-dir'].includes(argument) ||
      !argv[index + 1]
    ) {
      throw new Error(
        'Usage: verify-ios-testflight-attestation.mjs --tag <vX.Y.Z> ' +
          '--source-commit <40-hex-sha> --assets-dir <directory>',
      )
    }
    values.set(argument, argv[++index])
  }
  for (const required of ['--tag', '--source-commit', '--assets-dir']) {
    if (!values.has(required)) {
      throw new Error(`Missing required argument: ${required}`)
    }
  }

  const tag = values.get('--tag')
  const sourceCommit = values.get('--source-commit')
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid CatGo release tag: ${tag}`)
  }
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('Expected source commit must be an exact lowercase 40-hex SHA')
  }
  return {
    tag,
    sourceCommit,
    assetsDir: resolve(values.get('--assets-dir')),
  }
}

function readAttestation(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing TestFlight attestation: ${path}`)
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`TestFlight attestation must be a regular file: ${path}`)
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid TestFlight attestation JSON: ${error.message}`)
  }
}

function verifySchema(attestation) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('Invalid TestFlight attestation schema: expected an object')
  }
  const keys = Object.keys(attestation).sort()
  if (
    keys.length !== SCHEMA_KEYS.length ||
    keys.some((key, index) => key !== SCHEMA_KEYS[index])
  ) {
    throw new Error(
      `Invalid TestFlight attestation schema: expected only ${SCHEMA_KEYS.join(', ')}`,
    )
  }
  if (attestation.schemaVersion !== 1) {
    throw new Error('Invalid TestFlight attestation schema version')
  }
  if (
    typeof attestation.releaseTag !== 'string' ||
    !TAG_PATTERN.test(attestation.releaseTag)
  ) {
    throw new Error('Invalid TestFlight attestation release tag')
  }
  if (
    typeof attestation.sourceCommit !== 'string' ||
    !COMMIT_PATTERN.test(attestation.sourceCommit)
  ) {
    throw new Error('Invalid TestFlight attestation source commit')
  }
  if (
    typeof attestation.githubRunId !== 'string' ||
    !RUN_ID_PATTERN.test(attestation.githubRunId)
  ) {
    throw new Error('Invalid TestFlight attestation GitHub run id')
  }
  if (attestation.status !== 'accepted') {
    throw new Error('TestFlight attestation status must be accepted')
  }
}

function verifyAttestation({ tag, sourceCommit, assetsDir }) {
  const filename = `catgo-ios-testflight-${tag}.json`
  const attestation = readAttestation(resolve(assetsDir, filename))
  verifySchema(attestation)

  if (attestation.releaseTag !== tag) {
    throw new Error(
      `TestFlight attestation tag ${attestation.releaseTag} does not match ${tag}`,
    )
  }
  if (attestation.sourceCommit !== sourceCommit) {
    throw new Error(
      `TestFlight attestation source commit ${attestation.sourceCommit} ` +
        `does not match ${sourceCommit}`,
    )
  }
  return attestation
}

try {
  const attestation = verifyAttestation(
    parseArguments(process.argv.slice(2)),
  )
  console.log(
    `[ios-attestation] TestFlight upload accepted by run ${attestation.githubRunId}`,
  )
} catch (error) {
  console.error(`[ios-attestation] ${error.message}`)
  process.exitCode = 1
}
