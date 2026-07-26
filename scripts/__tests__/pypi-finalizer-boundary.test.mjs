import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PATH = resolve(ROOT, '.github/workflows/pypi-publish.yml')

function workflow() {
  return loadYaml(readFileSync(PATH, 'utf8'))
}

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name)
}

test('real PyPI publication starts only from a successful finalizer run or its exact manual proof', () => {
  const current = workflow()
  const trigger = current.on
  const dispatch = trigger.workflow_dispatch.inputs
  const job = current.jobs['build-and-publish']

  assert.equal(trigger.release, undefined)
  assert.deepEqual(trigger.workflow_run.workflows, [
    'Finalize verified CatGo release',
  ])
  assert.deepEqual(trigger.workflow_run.types, ['completed'])
  assert.equal(dispatch.dry_run.default, true)
  assert.equal(dispatch.release_tag.required, true)
  assert.equal(dispatch.finalizer_run_id.default, '')
  assert.match(job.if, /workflow_run\.conclusion == 'success'/)
  assert.match(job.if, /github\.event\.repository\.default_branch/)
  assert.equal(job.permissions.actions, 'read')
  assert.equal(job.permissions['id-token'], undefined)

  const resolveRun = stepNamed(job, 'Resolve finalizer run')
  assert.equal(
    resolveRun.env.TRIGGERED_FINALIZER_RUN_ID,
    '${{ github.event.workflow_run.id }}',
  )
  assert.equal(
    resolveRun.env.MANUAL_FINALIZER_RUN_ID,
    '${{ inputs.finalizer_run_id }}',
  )
  assert.equal(resolveRun.env.MANUAL_DRY_RUN, '${{ inputs.dry_run }}')
  assert.match(resolveRun.run, /finalizer_run_id is required/i)
  assert.match(resolveRun.run, /FINALIZER_RUN_ID=/)
  assert.match(resolveRun.run, /REQUIRE_FINALIZER_PROOF=/)

  const download = job.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/download-artifact@'),
  )
  assert.equal(download.with.name, 'catgo-release-finalization')
  assert.equal(download.with['run-id'], '${{ steps.finalizer.outputs.run_id }}')
  assert.equal(download.with['github-token'], '${{ secrets.GITHUB_TOKEN }}')
  assert.match(download.if, /steps\.finalizer\.outputs\.require_proof == 'true'/)

  const proof = stepNamed(job, 'Verify finalizer proof')
  assert.equal(proof.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}')
  assert.match(
    proof.run,
    /gh api "repos\/\$REPOSITORY\/actions\/runs\/\$FINALIZER_RUN_ID"/,
  )
  assert.match(proof.run, /\.github\/workflows\/finalize-release\.yml/)
  assert.match(proof.run, /\.event == "workflow_dispatch"/)
  assert.match(proof.run, /\.status == "completed"/)
  assert.match(proof.run, /\.conclusion == "success"/)
  assert.match(proof.run, /\.head_branch == \$defaultBranch/)
  assert.match(proof.run, /\.id == \(\$runId \| tonumber\)/)
  assert.match(proof.run, /catgo-release-finalization\.json/)
  assert.match(proof.run, /\.schemaVersion == 1/)
  assert.match(proof.run, /\.githubRunId == \$runId/)
  assert.match(proof.run, /release_tag=/)
  assert.match(proof.run, /source_commit=/)
  assert.match(proof.run, /asset_snapshot=/)
})

test('builds the exact attested tag and revalidates public release state immediately before PyPI', () => {
  const job = workflow().jobs['build-and-publish']
  const checkout = job.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  )
  assert.equal(checkout.with.ref, '${{ steps.request.outputs.release_tag }}')
  assert.equal(checkout.with['fetch-depth'], 0)

  for (const name of [
    'Verify release rights',
    'Verify release version',
    'Verify release source',
  ]) {
    assert.ok(stepNamed(job, name), `${name} remains mandatory`)
  }

  const verify = stepNamed(job, 'Revalidate finalized public release')
  const publish = stepNamed(job, 'Publish to PyPI')
  assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(publish))
  assert.equal(verify.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}')
  assert.match(verify.if, /steps\.finalizer\.outputs\.require_proof == 'true'/)
  assert.match(
    verify.run,
    /git fetch --force origin[\s\\]*"refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"/,
  )
  assert.match(verify.run, /git rev-parse HEAD/)
  assert.match(verify.run, /git rev-parse "\$RELEASE_TAG\^\{commit\}"/)
  assert.match(verify.run, /\.draft == false/)
  assert.match(verify.run, /\.published_at != null/)
  assert.match(
    verify.run,
    /\[\.assets\[\] \| \{id, name, size, digest, updated_at\}\] \| sort_by\(\.name\)/,
  )
  assert.match(verify.run, /EXPECTED_ASSET_SNAPSHOT/)
  assert.match(publish.if, /steps\.finalizer\.outputs\.require_proof == 'true'/)
  assert.doesNotMatch(publish.if, /github\.event_name == 'release'/)
})
