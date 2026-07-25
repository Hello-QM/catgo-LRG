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
  assert.equal(inputs.promote.type, 'boolean')
  assert.equal(inputs.promote.default, false)
  assert.equal(inputs.expected_source_commit.required, false)
  assert.equal(inputs.expected_asset_snapshot.required, false)
  assert.equal(inputs.promotion_id.required, false)
  assert.equal(current.concurrency['cancel-in-progress'], false)

  const credentials = stepNamed(
    current.jobs.mirror.steps,
    'Check R2 credentials configured',
  )
  assert.match(credentials.run, /PROMOTE_MODE/)
  assert.match(credentials.run, /promot/i)
  assert.match(credentials.run, /exit 1/)
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
  const sync = stepNamed(steps, 'Sync to R2')

  assert.ok(steps.indexOf(confirm) >= 0)
  assert.ok(steps.indexOf(recheck) > steps.indexOf(confirm))
  assert.ok(steps.indexOf(sync) > steps.indexOf(recheck))
  for (const step of [confirm, recheck]) {
    assert.match(step.run, /EXPECTED_SOURCE_COMMIT/)
    assert.match(step.run, /EXPECTED_ASSET_SNAPSHOT/)
    assert.match(step.run, /git rev-parse "\$tag\^\{commit\}"/)
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
})

test('publishes root index first and latest.json last as the commit marker', () => {
  const sync = stepNamed(workflow().jobs.mirror.steps, 'Sync to R2')
  const index = sync.run.indexOf(
    'aws s3 cp index.html "s3://$R2_BUCKET/index.html"',
  )
  const latest = sync.run.indexOf(
    'aws s3 cp dist/latest.json "s3://$R2_BUCKET/latest.json"',
  )
  assert.ok(index >= 0)
  assert.ok(latest > index, 'latest.json is the final root write')
  assert.match(sync.run, /PROMOTE_MODE/)
  assert.match(sync.run, /root_published=true/)
})

test('reconciles the versioned tag prefix to the exact validated asset inventory', () => {
  const sync = stepNamed(workflow().jobs.mirror.steps, 'Sync to R2')
  assert.match(
    sync.run,
    /aws s3 sync dist\/ "s3:\/\/\$R2_BUCKET\/\$tag\/" --delete/,
  )
})

test('verifies public root metadata only after the latest.json commit marker', () => {
  const steps = workflow().jobs.mirror.steps
  const sync = stepNamed(steps, 'Sync to R2')
  const verify = stepNamed(steps, 'Verify promoted Cloudflare endpoints')
  assert.ok(steps.indexOf(verify) > steps.indexOf(sync))
  assert.match(verify.run, /curl[\s\S]*\/latest\.json/)
  assert.match(verify.run, /curl[\s\S]*\/index\.html/)
  assert.match(verify.run, /MIRROR_TAG/)
})
