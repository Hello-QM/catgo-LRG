#!/usr/bin/env node

import { readFileSync } from 'node:fs'

function parseExitCode(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--exit-code' ||
    !/^\d+$/.test(argv[1])
  ) {
    throw new Error(
      'Usage: verify-testflight-upload-result.mjs --exit-code <integer>',
    )
  }
  const exitCode = Number(argv[1])
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error('altool exit code must be a safe nonnegative integer')
  }
  return exitCode
}

function verifyResult(exitCode, output) {
  if (exitCode !== 0) {
    throw new Error(`altool exited with exit code ${exitCode}`)
  }
  if (/UPLOAD FAILED|ERROR:/i.test(output)) {
    throw new Error('altool output contains a failure marker')
  }
  if (!/(?:^|\r?\n)\s*UPLOAD SUCCEEDED(?:\s|$)/i.test(output)) {
    throw new Error('altool output is missing explicit UPLOAD SUCCEEDED')
  }
}

try {
  const exitCode = parseExitCode(process.argv.slice(2))
  const output = readFileSync(0, 'utf8')
  verifyResult(exitCode, output)
  console.log('[testflight-upload] App Store Connect upload accepted')
} catch (error) {
  console.error(`[testflight-upload] ${error.message}`)
  process.exitCode = 1
}
