import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PATH = resolve(ROOT, '.github/workflows/r2-release-mirror.yml')
const SOURCE = readFileSync(PATH, 'utf8')

function workflow() {
  return loadYaml(SOURCE)
}

function stepNamed(steps, name) {
  return steps.find((step) => step.name === name)
}

test('manual promotion is explicit, serialized, and fails when R2 credentials are absent', () => {
  const current = workflow()
  const inputs = current.on.workflow_dispatch.inputs
  assert.equal(inputs.promote_root.type, 'boolean')
  assert.equal(inputs.promote_root.default, false)
  assert.equal(inputs.rollback_root.type, 'boolean')
  assert.equal(inputs.rollback_root.default, false)
  assert.equal(inputs.expected_source_commit.required, false)
  assert.equal(inputs.expected_asset_snapshot.required, false)
  assert.equal(inputs.promotion_id.required, false)
  assert.match(current.concurrency.group, /r2-root-mutation/)
  assert.match(current.concurrency.group, /inputs\.rollback_root/)
  assert.equal(current.concurrency['cancel-in-progress'], false)
  assert.deepEqual(current.permissions, {
    actions: 'read',
    contents: 'read',
  })

  const credentials = stepNamed(
    current.jobs.mirror.steps,
    'Check R2 credentials configured',
  )
  assert.match(credentials.run, /root_action/)
  assert.match(credentials.run, /promot/i)
  assert.match(credentials.run, /exit 1/)
  const resolveTag = stepNamed(current.jobs.mirror.steps, 'Resolve tag')
  assert.match(
    resolveTag.run,
    /\^\[A-Za-z0-9\]\(\[A-Za-z0-9\._-\]\{0,98\}\[A-Za-z0-9\]\)\?\$/,
  )
})

test('rollback resolution avoids release APIs, tag fetches, and rights gates', () => {
  const steps = workflow().jobs.mirror.steps
  const resolveTag = stepNamed(steps, 'Resolve tag')
  const rights = stepNamed(
    steps,
    'Verify target release rights before any R2 mutation',
  )
  const rootResolution = resolveTag.run.indexOf(
    '[ "$EVENT_NAME" = "workflow_dispatch" ]',
  )
  const releaseQuery = resolveTag.run.indexOf('gh api --paginate')

  assert.ok(rootResolution >= 0)
  assert.ok(releaseQuery > rootResolution)
  const rollbackSkip = rights.run.indexOf(
    '[ "$ROOT_ACTION" = "rollback_root" ]',
  )
  const tagFetch = rights.run.indexOf('git fetch --force origin')
  assert.ok(rollbackSkip >= 0)
  assert.ok(tagFetch > rollbackSkip)
})

test('keeps AWS credentials out of job-wide environment and scopes them to AWS steps', () => {
  const mirror = workflow().jobs.mirror
  assert.equal(mirror.env?.AWS_ACCESS_KEY_ID, undefined)
  assert.equal(mirror.env?.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(mirror.env?.AWS_ENDPOINT_URL, undefined)

  const awsSteps = mirror.steps.filter((step) => /\baws\s/.test(step.run ?? ''))
  assert.ok(awsSteps.length >= 2)
  for (const step of awsSteps) {
    assert.equal(
      step.env.AWS_ACCESS_KEY_ID,
      '${{ secrets.R2_ACCESS_KEY_ID }}',
    )
    assert.equal(
      step.env.AWS_SECRET_ACCESS_KEY,
      '${{ secrets.R2_SECRET_ACCESS_KEY }}',
    )
    assert.match(
      step.env.AWS_ENDPOINT_URL,
      /CLOUDFLARE_ACCOUNT_ID/,
    )
  }
})

test('binds draft promotion to the finalizer source and asset snapshot before upload', () => {
  const steps = workflow().jobs.mirror.steps
  const confirm = stepNamed(steps, 'Confirm requested promotion identity')
  const recheck = stepNamed(
    steps,
    'Re-confirm promotion identity before R2 mutation',
  )
  const sync = stepNamed(steps, 'Sync versioned release to R2')

  assert.ok(steps.indexOf(confirm) >= 0)
  assert.ok(steps.indexOf(recheck) > steps.indexOf(confirm))
  assert.ok(steps.indexOf(sync) > steps.indexOf(recheck))
  for (const step of [confirm, recheck]) {
    assert.match(step.run, /EXPECTED_SOURCE_COMMIT/)
    assert.match(step.run, /EXPECTED_ASSET_SNAPSHOT/)
    assert.match(step.run, /git rev-parse "\$tag\^\{commit\}"/)
    assert.match(
      step.run,
      /gh release view "\$tag"[\s\S]*--json databaseId/,
    )
    assert.match(
      step.run,
      /gh api "repos\/\$REPOSITORY\/releases\/\$release_id"/,
    )
    assert.match(step.run, /\.tag_name[\s\S]*\$tag/)
    assert.doesNotMatch(step.run, /releases\/tags\/\$tag/)
    assert.match(step.run, /\.draft/)
    assert.match(step.run, /asset_snapshot/)
  }
})

test('uses trusted default-branch verifiers and verifies the attested iOS workflow run', () => {
  const steps = workflow().jobs.mirror.steps
  const validate = stepNamed(steps, 'Validate release assets against target tag')
  assert.match(validate.run, /git worktree add --detach "\$target_source"/)
  assert.match(
    validate.run,
    /node scripts\/verify-release-rights\.mjs --root "\$target_source"/,
  )
  assert.match(
    validate.run,
    /node scripts\/verify-mirrored-release\.mjs[\s\S]*--source-root "\$target_source"/,
  )
  assert.match(
    validate.run,
    /gh api "repos\/\$REPOSITORY\/actions\/runs\/\$run_id"/,
  )
  assert.match(
    validate.run,
    /verify-ios-testflight-run\.mjs[\s\S]*--source-commit "\$source_commit"/,
  )
  assert.match(
    validate.run,
    /verify-trusted-ios-workflow\.mjs[\s\S]*--source-root "\$target_source"/,
  )
  assert.match(
    validate.run,
    /contents\/\.github\/workflows\/ios-build\.yml\?ref=\$run_head_sha/,
  )
  assert.match(
    validate.run,
    /verify-trusted-ios-workflow\.mjs[\s\S]*--source-root "\$run_source"/,
  )
  assert.match(
    validate.run,
    /verify-ios-testflight-run\.mjs[\s\S]*--run-workflow[\s\S]*ios-build\.yml/,
  )
})

test('only explicit promotion mutates root and writes index before latest commit marker', () => {
  const steps = workflow().jobs.mirror.steps
  const sync = stepNamed(steps, 'Sync versioned release to R2')
  const promote = stepNamed(steps, 'Back up and promote Cloudflare root')
  assert.doesNotMatch(sync.run, /s3:\/\/\$R2_BUCKET\/(?:index\.html|latest\.json)/)
  assert.match(promote.if, /inputs\.promote_root/)
  const receipt = promote.run.indexOf(
    '"s3://$R2_BUCKET/$receipt_key"',
  )
  const index = promote.run.indexOf(
    'aws s3 cp index.html "s3://$R2_BUCKET/index.html"',
  )
  const latest = promote.run.indexOf(
    'aws s3 cp dist/latest.json "s3://$R2_BUCKET/latest.json"',
  )
  assert.ok(receipt >= 0)
  assert.ok(index >= 0)
  assert.ok(
    receipt < index,
    'durable recovery receipt must exist before root mutation',
  )
  assert.ok(latest > index, 'latest.json is the final root write')
  assert.doesNotMatch(promote.run, /latest_app_tag/)
})

test('reconciles the versioned tag prefix to the exact validated asset inventory', () => {
  const sync = stepNamed(
    workflow().jobs.mirror.steps,
    'Sync versioned release to R2',
  )
  assert.match(
    sync.run,
    /aws s3 sync dist\/ "s3:\/\/\$R2_BUCKET\/\$tag\/" --delete/,
  )
})

test('verifies public root metadata only after the latest.json commit marker', () => {
  const steps = workflow().jobs.mirror.steps
  const sync = stepNamed(steps, 'Back up and promote Cloudflare root')
  const verify = stepNamed(steps, 'Verify promoted Cloudflare endpoints')
  assert.ok(steps.indexOf(verify) > steps.indexOf(sync))
  assert.match(verify.run, /curl[\s\S]*\/latest\.json/)
  assert.match(verify.run, /curl[\s\S]*\/index\.html/)
  assert.match(verify.run, /MIRROR_TAG/)
  assert.match(verify.run, /verify-release-promotion-receipt\.mjs/)
  assert.match(verify.run, /\.requiredAssets\[\]\.name/)
  assert.match(verify.run, /curl[\s\S]*--output "\$asset_path"/)
  assert.match(verify.run, /--assets-dir "\$assets_dir"/)
  assert.doesNotMatch(verify.run, /(?:--head|-I)[\s\S]*http_code/)
})

test('backs up old root and can restore and verify it through an explicit rollback', () => {
  const steps = workflow().jobs.mirror.steps
  const promote = stepNamed(steps, 'Back up and promote Cloudflare root')
  const rollback = stepNamed(steps, 'Restore previous Cloudflare root')
  assert.match(promote.run, /backup_prefix="promotion-backups\/\$PROMOTION_ID"/)
  assert.match(promote.run, /\$backup_prefix\/index\.html/)
  assert.match(promote.run, /\$backup_prefix\/latest\.json/)
  assert.match(promote.run, /\$backup_prefix\/promoted-index\.html/)
  assert.match(promote.run, /\$backup_prefix\/promoted-latest\.json/)
  assert.match(promote.run, /promotion-receipts\/\$PROMOTION_ID\.json/)
  assert.match(rollback.if, /inputs\.rollback_root/)
  assert.match(rollback.run, /verify-release-promotion-receipt\.mjs/)
  assert.match(rollback.run, /inspect_root_object/)
  assert.match(rollback.run, /promoted_hash/)
  assert.match(rollback.run, /previous_hash/)
  assert.match(rollback.run, /Unexpected current R2 root object/)
  const index = rollback.run.lastIndexOf('"s3://$R2_BUCKET/index.html"')
  const latest = rollback.run.lastIndexOf('"s3://$R2_BUCKET/latest.json"')
  assert.ok(index >= 0)
  assert.ok(latest > index, 'rollback restores latest.json last')
  assert.match(rollback.run, /rollback-receipts\/\$PROMOTION_ID\.json/)
  assert.match(rollback.run, /curl[\s\S]*sha256sum/)
})

test('compensates a partial promotion without pruning rollback dependencies', () => {
  const steps = workflow().jobs.mirror.steps
  const promote = stepNamed(steps, 'Back up and promote Cloudflare root')
  const compensate = stepNamed(
    steps,
    'Roll back failed Cloudflare promotion',
  )
  assert.match(promote.run, /trap rollback_partial_promotion ERR/)
  assert.match(promote.run, /backup_ready=true/)
  assert.match(compensate.if, /failure\(\)/)
  assert.match(compensate.if, /backup_ready/)
  assert.match(compensate.run, /--metadata-directive REPLACE/)
  assert.match(compensate.run, /content-type application\/json/)
  assert.match(compensate.run, /Failed-promotion compensation was not observable/)
  assert.equal(
    stepNamed(steps, 'Prune older app artifacts (retain versioned sidecars)'),
    undefined,
  )
})
