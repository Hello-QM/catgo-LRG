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
  assert.deepEqual(publish.needs, ['validate', 'promote-cloudflare'])

  const promotion = stepNamed(
    promote,
    'Dispatch and verify Cloudflare release promotion',
  )
  assert.match(
    promotion.run,
    /gh workflow run r2-release-mirror\.yml[\s\S]*-f "tag=\$RELEASE_TAG"[\s\S]*-f "promote=true"/,
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
})

test('preflight, publication, and postflight form one rollback-protected step', () => {
  const current = workflow()
  const publish = current.jobs.publish
  assert.deepEqual(publish.permissions, {
    actions: 'read',
    contents: 'write',
  })

  const mutationSteps = publish.steps.filter((step) =>
    /gh release edit/.test(step.run ?? ''),
  )
  assert.equal(mutationSteps.length, 1)
  const mutation = mutationSteps[0]
  assert.equal(
    mutation.name,
    'Publish with atomic identity recheck and rollback',
  )
  assert.match(mutation.run, /trap rollback ERR/)
  assert.match(
    mutation.run,
    /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=false[\s\S]*--latest/,
  )
  assert.match(
    mutation.run,
    /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=true/,
  )
  const firstSnapshot = mutation.run.indexOf('actual_snapshot=')
  const publishIndex = mutation.run.indexOf('--draft=false')
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
