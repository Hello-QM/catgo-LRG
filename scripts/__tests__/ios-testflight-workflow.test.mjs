import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PATH = resolve(ROOT, '.github/workflows/ios-build.yml')
const SOURCE = readFileSync(PATH, 'utf8')
const WORKFLOW = loadYaml(SOURCE)

test('keeps write permission out of the build job and scopes it to attestation upload', () => {
  const build = WORKFLOW.jobs.ios
  const attestation = WORKFLOW.jobs['publish-testflight-attestation']

  assert.deepEqual(build.permissions, { contents: 'read' })
  assert.deepEqual(attestation.permissions, { contents: 'write' })
  assert.equal(attestation.needs, 'ios')
  assert.equal(
    attestation.if,
    "${{ inputs.signed && inputs.upload && needs.ios.result == 'success' }}",
  )
})

test('binds the attestation to GITHUB_SHA and uploads it only to the matching draft release', () => {
  const buildSteps = WORKFLOW.jobs.ios.steps
  const source = buildSteps.find(
    (step) => step.name === 'Record exact release source',
  )
  assert.ok(source)
  assert.match(source.run, /git rev-parse HEAD/)
  assert.match(source.run, /GITHUB_SHA/)
  assert.match(source.run, /exit 1/)

  const testFlightUpload = buildSteps.find(
    (step) => step.name === 'Upload to App Store Connect (TestFlight)',
  )
  assert.ok(testFlightUpload)
  assert.match(
    testFlightUpload.run,
    /node scripts\/verify-testflight-upload-result\.mjs --exit-code "\$RC"/,
  )

  const job = WORKFLOW.jobs['publish-testflight-attestation']
  const run = job.steps.map((step) => step.run ?? '').join('\n')
  assert.match(run, /catgo-ios-testflight-\$\{RELEASE_TAG\}\.json/)
  assert.match(run, /"releaseTag"/)
  assert.match(run, /"sourceCommit"/)
  assert.match(run, /GITHUB_RUN_ID/)
  assert.match(run, /"accepted"/)
  assert.match(run, /gh api[\s\S]*\.draft/)
  assert.match(run, /gh release upload "\$RELEASE_TAG"[\s\S]*--clobber/)
  assert.doesNotMatch(run, /\$\{\{\s*inputs\.release_tag\s*\}\}/)
})
