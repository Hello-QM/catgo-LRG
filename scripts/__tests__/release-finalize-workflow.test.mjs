import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PATH = resolve(ROOT, '.github/workflows/finalize-release.yml')

test('finalization checks the exact tag with minimum release-write permission', () => {
  assert.equal(existsSync(PATH), true, 'finalize workflow must exist')
  const workflow = loadYaml(readFileSync(PATH, 'utf8'))
  const validate = workflow.jobs.validate
  const publish = workflow.jobs.publish

  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(validate.permissions, { contents: 'read' })
  assert.deepEqual(publish.permissions, { contents: 'write' })
  assert.equal(publish.needs, 'validate')
  assert.equal(validate.env.RELEASE_TAG, '${{ inputs.tag }}')
  assert.equal(publish.env.RELEASE_TAG, '${{ inputs.tag }}')

  const checkout = validate.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@'),
  )
  assert.equal(checkout.with.ref, '${{ inputs.tag }}')
  assert.equal(checkout.with['fetch-depth'], 0)
})

test('publishes only after source, draft, complete asset, and iOS gates pass in order', () => {
  const source = readFileSync(PATH, 'utf8')
  const workflow = loadYaml(source)
  const validationSteps = workflow.jobs.validate.steps
  const publicationSteps = workflow.jobs.publish.steps
  const index = (name) =>
    validationSteps.findIndex((step) => step.name === name)

  const ordered = [
    'Verify release rights',
    'Verify release version',
    'Verify release source',
    'Confirm release is a draft',
    'Download complete draft assets',
    'Prepare Cloudflare validation manifest',
    'Verify complete mirrored release',
    'Verify TestFlight acceptance',
  ]
  for (let position = 0; position < ordered.length; position += 1) {
    assert.notEqual(index(ordered[position]), -1, `${ordered[position]} exists`)
    if (position > 0) {
      assert.ok(
        index(ordered[position]) > index(ordered[position - 1]),
        `${ordered[position]} follows ${ordered[position - 1]}`,
      )
    }
  }

  const allRun = [...validationSteps, ...publicationSteps]
    .map((step) => step.run ?? '')
    .join('\n')
  assert.doesNotMatch(allRun, /\$\{\{\s*inputs\.tag\s*\}\}/)
  assert.match(allRun, /gh release download "\$RELEASE_TAG"/)
  assert.match(
    validationSteps[index('Prepare Cloudflare validation manifest')].env
      .R2_PUBLIC_BASE_URL,
    /^https:\/\/dl\.catgo-ucsd\.org$/,
  )
  assert.match(
    validationSteps[index('Verify complete mirrored release')].run,
    /verify-mirrored-release\.mjs[\s\S]*--tag "\$RELEASE_TAG"[\s\S]*--assets-dir "\$VALIDATION_ASSETS_DIR"[\s\S]*--source-root "\$GITHUB_WORKSPACE"/,
  )
  assert.match(
    validationSteps[index('Verify TestFlight acceptance')].run,
    /verify-ios-testflight-attestation\.mjs[\s\S]*--tag "\$RELEASE_TAG"[\s\S]*--source-commit "\$RELEASE_SOURCE_COMMIT"[\s\S]*--assets-dir "\$VALIDATION_ASSETS_DIR"/,
  )
  assert.deepEqual(
    publicationSteps.map((step) => step.name),
    [
      'Checkout validated release tag',
      'Re-confirm release is a draft',
      'Publish verified release',
    ],
  )
  assert.equal(publicationSteps[0].with.ref, '${{ inputs.tag }}')
  assert.equal(publicationSteps[0].with['fetch-depth'], 0)
  assert.match(publicationSteps[1].run, /git rev-parse HEAD/)
  assert.match(publicationSteps[1].run, /EXPECTED_SOURCE_COMMIT/)
  assert.match(
    publicationSteps[2].run,
    /gh release edit "\$RELEASE_TAG"[\s\S]*--draft=false[\s\S]*--latest/,
  )
})
