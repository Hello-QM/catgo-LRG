#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { RELEASE_TRUST_POLICY } from './release-trust-policy.mjs'

const IOS_WORKFLOW_PATH = '.github/workflows/ios-build.yml'

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--source-root' ||
    !argv[1]
  ) {
    throw new Error(
      'Usage: verify-trusted-ios-workflow.mjs --source-root <tag checkout>',
    )
  }
  return resolve(argv[1])
}

function main(sourceRoot) {
  const workflowPath = resolve(sourceRoot, IOS_WORKFLOW_PATH)
  const metadata = lstatSync(workflowPath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `Target iOS workflow must be a regular file: ${workflowPath}`,
    )
  }
  if (metadata.size > 512 * 1024) {
    throw new Error(`Target iOS workflow is unexpectedly large: ${workflowPath}`)
  }
  const actual = createHash('sha256')
    .update(readFileSync(workflowPath))
    .digest('hex')
  const approved = RELEASE_TRUST_POLICY.iosBuildWorkflowSha256s
  if (
    !Array.isArray(approved) ||
    approved.length === 0 ||
    approved.some((digest) => !/^[0-9a-f]{64}$/.test(digest))
  ) {
    throw new Error(
      'Trusted release policy has no approved iOS workflow hash allowlist',
    )
  }
  if (!approved.includes(actual)) {
    throw new Error(
      `Target iOS workflow hash ${actual} is not in the trusted allowlist`,
    )
  }
  process.stdout.write(`[ios-workflow] verified ${actual}\n`)
}

try {
  main(parseArguments(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`[ios-workflow] ${error.message}\n`)
  process.exitCode = 1
}
