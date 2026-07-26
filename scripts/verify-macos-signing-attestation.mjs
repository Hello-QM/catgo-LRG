#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  createReadStream,
  lstatSync,
  readFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const RUN_ID_PATTERN = /^[1-9]\d*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SCHEMA_KEYS = [
  'artifacts',
  'githubRunId',
  'releaseTag',
  'schemaVersion',
  'signer',
  'sourceCommit',
  'teamIdentifier',
]
const ARTIFACT_KEYS = ['name', 'sha256']

function exactKeys(value, expected, kind) {
  const keys = Object.keys(value).sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${kind} must contain only ${expected.join(', ')}`)
  }
}
function parseArguments(argv) {
  const allowed = new Set([
    '--tag',
    '--source-commit',
    '--assets-dir',
    '--expected-signer',
    '--expected-team',
  ])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(argument) || value === undefined || values.has(argument)) {
      throw new Error(
        'Usage: verify-macos-signing-attestation.mjs --tag <vX.Y.Z> ' +
          '--source-commit <40-hex-sha> --assets-dir <directory> ' +
          '--expected-signer <Developer-ID identity> --expected-team <team-id>',
      )
    }
    values.set(argument, value)
    index += 1
  }
  for (const required of allowed) {
    if (!values.has(required) || values.get(required).length === 0) {
      throw new Error(`Missing required argument: ${required}`)
    }
  }

  const tag = values.get('--tag')
  const match = TAG_PATTERN.exec(tag)
  if (!match) throw new Error(`Invalid CatGo release tag: ${tag}`)
  const sourceCommit = values.get('--source-commit')
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('Expected source commit must be an exact lowercase 40-hex SHA')
  }

  return {
    tag,
    version: match[1],
    sourceCommit,
    assetsDir: resolve(values.get('--assets-dir')),
    expectedSigner: values.get('--expected-signer'),
    expectedTeam: values.get('--expected-team'),
  }
}

function readRegularJson(path, kind) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${kind} must be a regular file: ${path}`)
  }
  if (metadata.size > 64 * 1024) {
    throw new Error(`${kind} is unexpectedly large: ${path}`)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${kind} is invalid JSON: ${error.message}`)
  }
}

function expectedArtifacts(version) {
  return [
    {
      label: 'DMG',
      name: `CatGo_${version}_aarch64.dmg`,
    },
    {
      label: 'updater archive',
      name: 'CatGo_aarch64.app.tar.gz',
    },
  ]
}

function verifySchema(attestation, options) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('macOS signing attestation must be an object')
  }
  exactKeys(attestation, SCHEMA_KEYS, 'macOS signing attestation')
  if (attestation.schemaVersion !== 1) {
    throw new Error('macOS signing attestation has an unsupported schema version')
  }
  if (attestation.releaseTag !== options.tag) {
    throw new Error('macOS signing attestation release tag does not match')
  }
  if (attestation.sourceCommit !== options.sourceCommit) {
    throw new Error('macOS signing attestation source commit does not match')
  }
  if (
    typeof attestation.githubRunId !== 'string' ||
    !RUN_ID_PATTERN.test(attestation.githubRunId)
  ) {
    throw new Error('macOS signing attestation has an invalid GitHub run id')
  }
  if (attestation.signer !== options.expectedSigner) {
    throw new Error('macOS signing attestation signer does not match')
  }
  if (attestation.teamIdentifier !== options.expectedTeam) {
    throw new Error('macOS signing attestation team identifier does not match')
  }
  if (!options.expectedSigner.endsWith(` (${options.expectedTeam})`)) {
    throw new Error('Expected Developer-ID signer is not bound to the expected team')
  }
  if (!Array.isArray(attestation.artifacts)) {
    throw new Error('macOS signing attestation artifacts must be an array')
  }

  const expected = expectedArtifacts(options.version)
  if (attestation.artifacts.length !== expected.length) {
    throw new Error('macOS signing attestation must cover exactly two artifacts')
  }
  return expected.map((requirement, index) => {
    const artifact = attestation.artifacts[index]
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error(`macOS signing attestation ${requirement.label} is invalid`)
    }
    exactKeys(
      artifact,
      ARTIFACT_KEYS,
      `macOS signing attestation ${requirement.label}`,
    )
    if (artifact.name !== requirement.name) {
      throw new Error(
        `macOS signing attestation ${requirement.label} must be ${requirement.name}`,
      )
    }
    if (
      typeof artifact.sha256 !== 'string' ||
      !SHA256_PATTERN.test(artifact.sha256)
    ) {
      throw new Error(
        `macOS signing attestation ${requirement.label} has invalid SHA-256`,
      )
    }
    return { ...requirement, sha256: artifact.sha256 }
  })
}

async function sha256File(path, label) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`macOS ${label} must be a regular file: ${path}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verify(options) {
  const attestationPath = resolve(
    options.assetsDir,
    `catgo-macos-signing-${options.tag}.json`,
  )
  const attestation = readRegularJson(
    attestationPath,
    'macOS signing attestation',
  )
  const artifacts = verifySchema(attestation, options)
  for (const artifact of artifacts) {
    const actual = await sha256File(
      resolve(options.assetsDir, artifact.name),
      artifact.label,
    )
    if (actual !== artifact.sha256) {
      throw new Error(
        `SHA-256 mismatch for macOS ${artifact.label}: ` +
          `expected ${artifact.sha256}, got ${actual}`,
      )
    }
  }
  return attestation
}

try {
  const attestation = await verify(parseArguments(process.argv.slice(2)))
  console.log(
    `[macos-signing-attestation] verified run ${attestation.githubRunId}`,
  )
} catch (error) {
  console.error(`[macos-signing-attestation] ${error.message}`)
  process.exitCode = 1
}
