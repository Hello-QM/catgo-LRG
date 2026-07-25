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
  /(?:gh release (?:create|upload)|aws s3 (?:sync|cp)|xcrun altool|vsce publish|ovsx publish)/
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
  assert.match(targetGate.run, /git archive "\$tag"/)
  assert.match(
    targetGate.run,
    /node scripts\/verify-release-rights\.mjs --root "\$target_source"/,
  )
})
