import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PATH = resolve(ROOT, '.github/workflows/finalize-release.yml')

function workflow() {
  assert.equal(existsSync(PATH), true, 'finalize workflow must exist')
  return loadYaml(readFileSync(PATH, 'utf8'))
}

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name)
}

test('executes only trusted default-branch verifiers against a detached target worktree', () => {
  const current = workflow()
  const validate = current.jobs.validate
  const checkout = validate.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  )
  assert.equal(
    checkout.with.ref,
    '${{ github.event.repository.default_branch }}',
  )
  assert.equal(checkout.with['fetch-depth'], 0)

  const prepare = stepNamed(validate, 'Prepare detached target release source')
  assert.match(prepare.run, /git fetch --force origin "refs\/tags\/\$tag:/)
  assert.match(prepare.run, /git worktree add --detach "\$target_source"/)
  assert.match(prepare.run, /TARGET_SOURCE=/)
  assert.match(prepare.run, /RELEASE_SOURCE_COMMIT=/)

  const validationRun = validate.steps.map((step) => step.run ?? '').join('\n')
  assert.match(
    validationRun,
    /node scripts\/verify-release-rights\.mjs --root "\$TARGET_SOURCE"/,
  )
  assert.match(
    validationRun,
    /node scripts\/verify-release-version\.mjs[\s\S]*--root "\$TARGET_SOURCE"/,
  )
  assert.match(
    validationRun,
    /node scripts\/verify-release-source\.mjs[\s\S]*--root "\$TARGET_SOURCE"/,
  )
  assert.match(
    validationRun,
    /node scripts\/verify-mirrored-release\.mjs[\s\S]*--source-root "\$TARGET_SOURCE"/,
  )
  assert.doesNotMatch(
    validationRun,
    /(?:^|\s)node "\$TARGET_SOURCE\/scripts\//,
  )
})

test('proves the TestFlight attestation came from the exact successful iOS workflow run', () => {
  const validate = workflow().jobs.validate
  const attestation = stepNamed(validate, 'Verify TestFlight acceptance')
  const runProof = stepNamed(validate, 'Verify TestFlight workflow provenance')
  const attestationIndex = validate.steps.indexOf(attestation)
  const proofIndex = validate.steps.indexOf(runProof)

  assert.ok(attestationIndex >= 0)
  assert.ok(proofIndex > attestationIndex)
  assert.match(runProof.run, /catgo-ios-testflight-\$\{RELEASE_TAG\}\.json/)
  assert.match(
    runProof.run,
    /gh api "repos\/\$REPOSITORY\/actions\/runs\/\$run_id"/,
  )
  assert.match(
    runProof.run,
    /gh api --paginate --slurp[\s\S]*"repos\/\$REPOSITORY\/actions\/runs\/\$run_id\/jobs\?per_page=100"/,
  )
  assert.match(
    runProof.run,
    /verify-ios-testflight-run\.mjs[\s\S]*--attestation[\s\S]*--run[\s\S]*--jobs[\s\S]*--source-commit/,
  )
  assert.match(
    runProof.run,
    /verify-trusted-ios-workflow\.mjs[\s\S]*--source-root "\$TARGET_SOURCE"/,
  )
  assert.match(
    runProof.run,
    /contents\/\.github\/workflows\/ios-build\.yml\?ref=\$run_head_sha/,
  )
  assert.match(
    runProof.run,
    /verify-trusted-ios-workflow\.mjs[\s\S]*--source-root "\$run_source"/,
  )
  assert.match(
    runProof.run,
    /verify-ios-testflight-run\.mjs[\s\S]*--run-workflow[\s\S]*ios-build\.yml/,
  )
})

test('proves macOS signatures came from the pinned successful Tauri workflow run', () => {
  const validate = workflow().jobs.validate
  const proof = stepNamed(validate, 'Verify macOS workflow provenance')
  assert.match(proof.run, /catgo-macos-signing-\$\{RELEASE_TAG\}\.json/)
  assert.match(
    proof.run,
    /gh api "repos\/\$REPOSITORY\/actions\/runs\/\$run_id"/,
  )
  assert.match(
    proof.run,
    /verify-macos-signing-run\.mjs[\s\S]*--source-commit "\$RELEASE_SOURCE_COMMIT"[\s\S]*--target-workflow[\s\S]*"\$TARGET_SOURCE\/\.github\/workflows\/tauri-build\.yml"/,
  )
})

test('promotes and verifies Cloudflare before granting GitHub release visibility', () => {
  const current = workflow()
  const promote = current.jobs['promote-cloudflare']
  const publish = current.jobs.publish

  assert.deepEqual(promote.needs, ['validate'])
  assert.deepEqual(promote.permissions, {
    actions: 'write',
    contents: 'read',
  })
  assert.deepEqual(publish.needs, [
    'validate',
    'promote-cloudflare',
    'publication-intent',
  ])
  assert.equal(
    promote.outputs.promotion_id,
    '${{ steps.promotion.outputs.promotion_id }}',
  )

  const promotion = stepNamed(
    promote,
    'Dispatch and verify Cloudflare release promotion',
  )
  assert.match(
    promotion.run,
    /gh workflow run r2-release-mirror\.yml[\s\S]*-f "tag=\$RELEASE_TAG"[\s\S]*-f "promote_root=true"/,
  )
  assert.match(promotion.run, /expected_source_commit=/)
  assert.match(promotion.run, /expected_asset_snapshot=/)
  assert.match(promotion.run, /gh run view "\$promotion_run_id"/)
  assert.match(promotion.run, /conclusion.*success/)
  assert.match(
    promotion.run,
    /curl[\s\S]*https:\/\/dl\.catgo-ucsd\.org\/latest\.json/,
  )
  assert.match(
    promotion.run,
    /curl[\s\S]*https:\/\/dl\.catgo-ucsd\.org\/index\.html/,
  )
  assert.match(
    promotion.run,
    /promotion-receipts\/\$promotion_id\.json/,
  )
  assert.match(
    promotion.run,
    /verify-release-promotion-receipt\.mjs/,
  )
  assert.match(promotion.run, /\.requiredAssets\[\]\.name/)
  assert.match(promotion.run, /curl[\s\S]*--output "\$asset_path"/)
  assert.match(promotion.run, /--assets-dir "\$assets_dir"/)
})

test('globally serializes finalization across release tags', () => {
  const current = workflow()
  assert.equal(current.concurrency.group, 'finalize-release')
  assert.equal(current.concurrency['cancel-in-progress'], false)
})

test('emits a finalization attestation only after the reversible commit succeeds', () => {
  const current = workflow()
  const attestation = current.jobs['attest-finalization']

  assert.deepEqual(attestation.needs, [
    'validate',
    'promote-cloudflare',
    'publication-intent',
    'publish',
  ])
  assert.deepEqual(attestation.permissions, {
    actions: 'read',
    contents: 'read',
  })
  const create = stepNamed(attestation, 'Create finalization attestation')
  assert.match(create.run, /schemaVersion: 1/)
  assert.match(create.run, /releaseTag/)
  assert.match(create.run, /sourceCommit/)
  assert.match(create.run, /assetSnapshot/)
  assert.match(create.run, /githubRunId/)
  assert.match(create.run, /catgo-release-finalization\.json/)
  const upload = attestation.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/upload-artifact@'),
  )
  assert.equal(upload.with.name, 'catgo-release-finalization')
  assert.equal(upload.with.path, 'catgo-release-finalization.json')
  assert.equal(upload.with['if-no-files-found'], 'error')
})

test('independently compensates every failed finalization path after validation', () => {
  const current = workflow()
  const cleanup = current.jobs['compensate-finalization-failure']

  assert.deepEqual(cleanup.needs, [
    'validate',
    'promote-cloudflare',
    'publication-intent',
    'publish',
  ])
  assert.match(cleanup.if, /always\(\)/)
  assert.match(cleanup.if, /validate\.result == 'success'/)
  assert.match(cleanup.if, /publish\.result != 'success'/)
  assert.deepEqual(cleanup.permissions, {
    actions: 'write',
    contents: 'write',
  })
  assert.match(
    cleanup.env.PROMOTION_ID,
    /needs\.promote-cloudflare\.outputs\.promotion_id/,
  )
  assert.match(cleanup.env.PROMOTION_ID, /github\.run_attempt/)
  const run = cleanup.steps.map((step) => step.run ?? '').join('\n')
  assert.match(run, /promotion_title=/)
  assert.match(run, /gh run view "\$promotion_run_id"/)
  assert.match(run, /promotion_terminal=false/)
  assert.match(run, /\.status == "completed"/)
  assert.doesNotMatch(
    run,
    /No R2 promotion run was dispatched;[\s\S]*exit 0/,
  )
  assert.match(run, /promotion-receipts\/\$PROMOTION_ID\.json/)
  assert.match(run, /write-out '%\{http_code\}'/)
  assert.match(
    run,
    /gh api[\s\\]*"repos\/\$REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/,
  )
  assert.match(
    run,
    /gh workflow run r2-release-mirror\.yml[\s\S]*-f "rollback_root=true"/,
  )
  assert.match(run, /gh run watch "\$rollback_run_id"/)
  assert.match(run, /conclusion.*success/)
})

test('preflight, publication, and postflight revalidate Cloudflare in one rollback-protected step', () => {
  const current = workflow()
  const intent = current.jobs['publication-intent']
  const publish = current.jobs.publish
  assert.deepEqual(publish.permissions, {
    actions: 'write',
    contents: 'write',
  })
  assert.deepEqual(intent.needs, ['validate', 'promote-cloudflare'])
  assert.equal(
    intent.outputs.publish_attempted,
    '${{ steps.intent.outputs.publish_attempted }}',
  )
  const publishIntent = intent.steps.find((step) => step.id === 'intent')
  assert.match(publishIntent.run, /publish_attempted=true/)

  const mutationSteps = publish.steps.filter((step) =>
    /gh release edit/.test(step.run ?? ''),
  )
  assert.equal(mutationSteps.length, 1)
  const mutation = mutationSteps[0]
  assert.equal(
    mutation.name,
    'Publish with atomic identity recheck and rollback',
  )
  assert.doesNotMatch(mutation.run, /publish_attempted=/)
  assert.match(mutation.run, /trap rollback ERR/)
  assert.match(
    mutation.run,
    /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=false[\s\S]*--latest/,
  )
  assert.match(
    mutation.run,
    /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=true/,
  )
  assert.match(
    mutation.run,
    /gh api "repos\/\$REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/,
  )
  assert.doesNotMatch(mutation.run, /if \[ "\$published" = "true" \]/)
  assert.match(
    mutation.run,
    /gh workflow run r2-release-mirror\.yml[\s\S]*-f "rollback_root=true"/,
  )
  assert.match(mutation.run, /gh run watch "\$rollback_run_id"/)
  assert.match(
    mutation.run,
    /rollback-receipts\/\$PROMOTION_ID\.json/,
  )
  const cloudflareChecks = mutation.run.match(
    /verify_cloudflare_promotion/g,
  ) ?? []
  assert.ok(cloudflareChecks.length >= 3)
  const firstCloudflare = mutation.run.indexOf('verify_cloudflare_promotion')
  const publishIndex = mutation.run.indexOf('--draft=false')
  const lastCloudflare = mutation.run.lastIndexOf('verify_cloudflare_promotion')
  assert.ok(firstCloudflare >= 0 && firstCloudflare < publishIndex)
  assert.ok(lastCloudflare > publishIndex)
  assert.match(
    mutation.run,
    /verify-release-promotion-receipt\.mjs/,
  )
  assert.doesNotMatch(
    mutation.run,
    /(?:--head|-I)[\s\S]*http_code/,
  )
  assert.match(mutation.run, /\.requiredAssets\[\]\.name/)
  assert.match(mutation.run, /--assets-dir "\$assets_dir"/)
  const firstSnapshot = mutation.run.indexOf('actual_snapshot=')
  const secondSnapshot = mutation.run.indexOf(
    'post_snapshot=',
    publishIndex,
  )
  assert.ok(firstSnapshot >= 0 && firstSnapshot < publishIndex)
  assert.ok(secondSnapshot > publishIndex)
  assert.match(mutation.run, /post_draft.*false/)
  assert.match(mutation.run, /post_source_commit/)
})

test('keeps release write permission out of validation and Cloudflare promotion', () => {
  const current = workflow()
  assert.deepEqual(current.permissions, {
    actions: 'read',
    contents: 'read',
  })
  assert.deepEqual(current.jobs.validate.permissions, {
    actions: 'read',
    contents: 'read',
  })
  assert.deepEqual(current.jobs['promote-cloudflare'].permissions, {
    actions: 'write',
    contents: 'read',
  })
})
