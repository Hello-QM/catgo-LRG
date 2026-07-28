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
const ANDROID_WORKFLOW = loadYaml(
  readFileSync(resolve(ROOT, '.github/workflows/android-build.yml'), 'utf8'),
)

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

test('stages legal resources before every iOS build', () => {
  const buildSteps = WORKFLOW.jobs.ios.steps
  const legal = buildSteps.findIndex(
    (step) => step.name === 'Stage legal bundle for iOS resources',
  )
  const signedBuild = buildSteps.findIndex(
    (step) => step.name === 'Build (signed device IPA)',
  )
  const simulatorBuild = buildSteps.findIndex(
    (step) => step.name === 'Build (simulator, unsigned)',
  )
  assert.ok(legal >= 0)
  assert.ok(legal < signedBuild)
  assert.ok(legal < simulatorBuild)
  assert.match(buildSteps[legal].run, /scripts\/sync-legal-bundle\.mjs/)
})

test('mobile archive checks exclude only the legal-sync ownership sentinel', () => {
  const cases = [
    [
      WORKFLOW.jobs.ios.steps.find(
        (step) => step.name === 'Verify legal bundle in iOS artifacts',
      ),
      2,
    ],
    [
      ANDROID_WORKFLOW.jobs.android.steps.find(
        (step) => step.name === 'Verify legal bundle in APK/AAB',
      ),
      1,
    ],
  ]
  for (const [step, expectedCount] of cases) {
    assert.ok(step)
    assert.equal(
      [...step.run.matchAll(/! -name ['"]\.catgo-legal-bundle-owned['"]/g)]
        .length,
      expectedCount,
    )
  }
})

test('binds direct and trusted exact-tag backfill uploads to the release source', () => {
  const buildSteps = WORKFLOW.jobs.ios.steps
  assert.equal(
    WORKFLOW.on.workflow_dispatch.inputs.exact_tag_backfill.type,
    'boolean',
  )
  assert.equal(
    WORKFLOW.on.workflow_dispatch.inputs.exact_tag_backfill.default,
    false,
  )
  const source = buildSteps.find(
    (step) => step.name === 'Record exact release source',
  )
  assert.ok(source)
  assert.match(source.run, /git rev-parse HEAD/)
  assert.match(source.run, /GITHUB_SHA/)
  assert.match(source.run, /refs\/tags\/\$RELEASE_TAG/)
  assert.match(source.run, /ALLOW_EXACT_TAG_BACKFILL/)
  assert.match(source.run, /refs\/heads\/\$DEFAULT_BRANCH/)
  assert.match(source.run, /V146_TAG/)
  assert.match(source.run, /V146_SOURCE_COMMIT/)
  assert.equal(source.env.V146_TAG, 'v1.4.6')
  assert.equal(
    source.env.V146_SOURCE_COMMIT,
    '06c02979b9e917011a63dcbfb09aaad7cfb9430d',
  )
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
  assert.match(run, /RELEASE_SOURCE_COMMIT/)
  assert.match(run, /commits\/\$RELEASE_TAG/)
  assert.match(
    run,
    /gh release view "\$RELEASE_TAG"[\s\S]*--json isDraft[\s\S]*--jq '\.isDraft'/,
  )
  assert.doesNotMatch(run, /releases\/tags\/\$RELEASE_TAG/)
  assert.match(run, /gh release upload "\$RELEASE_TAG"[\s\S]*--clobber/)
  assert.doesNotMatch(run, /\$\{\{\s*inputs\.release_tag\s*\}\}/)
})
