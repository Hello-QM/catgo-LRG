import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RIGHTS_COMMAND = 'node scripts/verify-release-rights.mjs'

const RELEASE_JOBS = {
  'android-build.yml': ['android'],
  'build-stt-accel.yml': ['build', 'manifest'],
  'build-vscode-sidecars.yml': ['build'],
  'deploy-cloudflare.yml': [
    'deploy-app',
    'deploy-docs',
    'deploy-downloads',
  ],
  'docker-publish.yml': ['build-and-push'],
  'hpc-bundle.yml': ['build-bundle'],
  'ios-build.yml': ['ios'],
  'pypi-publish.yml': ['build-and-publish'],
  'r2-release-mirror.yml': ['mirror'],
  'tauri-build.yml': ['build'],
  'tauri-test-build.yml': [
    'build-windows',
    'build-macos',
    'build-macos-intel',
  ],
  'vsix-publish.yml': ['publish'],
}

const PUBLICATION_SIGNAL =
  /(?:gh release (?:create|upload)|aws s3 (?:sync|cp)|xcrun altool|vsce publish|ovsx publish|pnpm dlx wrangler@\S+ deploy)/
const PUBLICATION_ACTION =
  /(?:actions\/upload-artifact|cloudflare\/wrangler-action|docker\/build-push-action|pypa\/gh-action-pypi-publish|softprops\/action-gh-release|tauri-apps\/tauri-action)/

function workflow(name) {
  const contents = readFileSync(
    resolve(ROOT, '.github/workflows', name),
    'utf8',
  )
  return loadYaml(contents)
}

function publishes(step) {
  return (
    PUBLICATION_SIGNAL.test(typeof step.run === 'string' ? step.run : '') ||
    PUBLICATION_ACTION.test(typeof step.uses === 'string' ? step.uses : '')
  )
}

test('every CatGo release job runs the shared rights gate before publishing', () => {
  for (const [workflowName, jobNames] of Object.entries(RELEASE_JOBS)) {
    const parsed = workflow(workflowName)
    for (const jobName of jobNames) {
      const steps = parsed.jobs[jobName].steps
      const checkout = steps.findIndex((step) =>
        /^actions\/checkout@/.test(step.uses ?? ''),
      )
      const gate = steps.findIndex(
        (step) =>
          typeof step.run === 'string' &&
          step.run.includes(RIGHTS_COMMAND),
      )
      const publication = steps.findIndex(publishes)

      assert.notEqual(checkout, -1, `${workflowName}:${jobName} checks out source`)
      assert.notEqual(
        publication,
        -1,
        `${workflowName}:${jobName} has a publication boundary`,
      )
      assert.ok(
        gate > checkout && gate < publication,
        `${workflowName}:${jobName} must run ${RIGHTS_COMMAND} after checkout ` +
          'and before publishing',
      )
      assert.equal(
        steps[gate].if,
        steps[checkout].if,
        `${workflowName}:${jobName} rights gate must run whenever checkout runs`,
      )
    }
  }
})

test('release path filters include provenance and the shared rights verifier', () => {
  const expected = {
    'deploy-cloudflare.yml': ['push'],
    'docker-publish.yml': ['push', 'pull_request'],
    'hpc-bundle.yml': ['push'],
  }
  for (const [workflowName, triggers] of Object.entries(expected)) {
    const parsed = workflow(workflowName)
    for (const trigger of triggers) {
      const paths = parsed.on[trigger].paths
      assert.ok(
        paths.includes('third_party/provenance/**'),
        `${workflowName}:${trigger} watches canonical provenance`,
      )
      assert.ok(
        paths.includes('scripts/verify-release-rights.mjs'),
        `${workflowName}:${trigger} watches the release-rights verifier`,
      )
    }
  }
})

test('R2 evaluates rights from the target release instead of the default branch', () => {
  const steps = workflow('r2-release-mirror.yml').jobs.mirror.steps
  const targetGate = steps.find(
    (step) =>
      typeof step.run === 'string' &&
      step.run.includes('node scripts/verify-release-rights.mjs'),
  )
  assert.ok(targetGate, 'R2 has an active release-rights verifier')
  assert.match(
    targetGate.run,
    /git worktree add --detach "\$target_rights_source" "\$rights_commit"/,
  )
  assert.match(
    targetGate.run,
    /rights_commit=\$\(git rev-parse "\$tag\^\{commit\}"\)[\s\S]*node scripts\/verify-release-rights\.mjs[\s\S]*--root "\$target_rights_source"/,
  )
})

test('STT evaluates target-tag rights before every first publication mutation', () => {
  const parsed = workflow('build-stt-accel.yml')

  for (const jobName of ['build', 'manifest']) {
    const steps = parsed.jobs[jobName].steps
    const gate = steps.findIndex(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes(RIGHTS_COMMAND),
    )
    const publication = steps.findIndex(publishes)

    assert.notEqual(gate, -1, `build-stt-accel.yml:${jobName} has a rights gate`)
    assert.ok(
      gate < publication,
      `build-stt-accel.yml:${jobName} gates its first publication mutation`,
    )
    assert.match(
      steps[gate].run,
      /git worktree add --detach "\$target_rights_source" "\$rights_commit"/,
      `build-stt-accel.yml:${jobName} checks the resolved target source`,
    )
    assert.match(
      steps[gate].run,
      /node scripts\/verify-release-rights\.mjs[\s\S]*--root "\$target_rights_source"/,
      `build-stt-accel.yml:${jobName} verifies the target source root`,
    )
  }
})

test('STT rechecks its exact cleared commit around draft publication mutations', () => {
  const parsed = workflow('build-stt-accel.yml')
  const buildSteps = parsed.jobs.build.steps
  const manifestSteps = parsed.jobs.manifest.steps
  const buildGate = buildSteps.find(
    (step) => step.name === 'Verify target STT release rights',
  )
  const manifestGate = manifestSteps.find(
    (step) => step.name === 'Verify target STT release rights',
  )
  const buildPublish = buildSteps.find(
    (step) => step.name === 'Upload to release',
  )
  const manifestPublish = manifestSteps.find(
    (step) => step.name === 'Upload manifest and publish release',
  )

  for (const [jobName, gate] of [
    ['build', buildGate],
    ['manifest', manifestGate],
  ]) {
    assert.match(
      gate.run,
      /echo "RIGHTS_COMMIT=\$rights_commit" >> "\$GITHUB_ENV"/,
      `${jobName} persists the exact cleared commit`,
    )
  }

  assert.ok(buildPublish, 'build has a release publication step')
  assert.match(
    buildPublish.run,
    /assert_tag_commit\(\) \{[\s\S]*git fetch --force origin\s*\\?\s*"\+refs\/tags\/\$TAG:refs\/tags\/\$TAG"[\s\S]*actual_commit=\$\(git rev-parse "\$TAG\^\{commit\}"\)[\s\S]*"\$actual_commit" != "\$RIGHTS_COMMIT"/,
  )
  assert.match(
    buildPublish.run,
    /if ! gh release view "\$TAG"[\s\S]*then\s+assert_tag_commit\s+if ! gh release create "\$TAG" --draft --latest=false/,
    'the exact tag is freshly checked immediately before draft creation',
  )
  assert.match(
    buildPublish.run,
    /if ! gh release create[\s\S]*then[\s\S]*gh release view "\$TAG"[\s\S]*\|\| exit 1\s+fi/,
    'a matrix create loser verifies the winning release',
  )
  assert.match(
    buildPublish.run,
    /assert_tag_commit\s+gh release upload "\$TAG"/,
    'build rechecks the tag immediately before asset upload',
  )
  assert.doesNotMatch(
    buildPublish.run,
    /gh release edit/,
    'matrix builds never publish the draft',
  )

  assert.ok(manifestPublish, 'manifest owns final publication')
  assert.match(
    manifestPublish.run,
    /assert_tag_commit\(\) \{[\s\S]*git fetch --force origin\s*\\?\s*"\+refs\/tags\/\$TAG:refs\/tags\/\$TAG"[\s\S]*actual_commit=\$\(git rev-parse "\$TAG\^\{commit\}"\)[\s\S]*"\$actual_commit" != "\$RIGHTS_COMMIT"/,
  )
  const manifestUpload = manifestPublish.run.indexOf(
    'gh release upload "$TAG" stt-accel-manifest.json --clobber',
  )
  const finalRecheck = manifestPublish.run.indexOf(
    'assert_tag_commit',
    manifestUpload + 1,
  )
  const publishDraft = manifestPublish.run.indexOf(
    'gh release edit "$TAG" --draft=false',
  )
  assert.ok(manifestUpload >= 0, 'manifest is uploaded')
  assert.match(
    manifestPublish.run.slice(0, manifestUpload),
    /assert_tag_commit\s*$/,
    'manifest upload immediately follows an exact tag recheck',
  )
  assert.ok(
    finalRecheck > manifestUpload && publishDraft > finalRecheck,
    'draft publication follows the manifest upload and a fresh exact recheck',
  )
})
