import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE_COMMAND = 'node scripts/verify-release-source.mjs'

function workflow(name) {
  return loadYaml(
    readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8'),
  )
}

const RELEASE_WORKFLOWS = [
  {
    file: 'tauri-build.yml',
    job: 'build',
    checkoutRef:
      "${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || github.ref }}",
    tag:
      "${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}",
    requireTag: "${{ startsWith(github.ref, 'refs/tags/') }}",
  },
  {
    file: 'android-build.yml',
    job: 'android',
    checkoutRef:
      "${{ inputs.release_tag != '' && inputs.release_tag || github.ref }}",
    tag: '${{ inputs.release_tag }}',
    requireTag: "${{ inputs.release_tag != '' }}",
  },
  {
    file: 'hpc-bundle.yml',
    job: 'build-bundle',
    checkoutRef:
      "${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || inputs.release_tag != '' && inputs.release_tag || github.ref }}",
    tag:
      "${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || inputs.release_tag }}",
    requireTag:
      "${{ startsWith(github.ref, 'refs/tags/') || inputs.release_tag != '' }}",
  },
  {
    file: 'ios-build.yml',
    job: 'ios',
    checkoutRef:
      "${{ inputs.release_tag != '' && inputs.release_tag || github.ref }}",
    tag: '${{ inputs.release_tag }}',
    requireTag: '${{ inputs.upload }}',
  },
  {
    file: 'vsix-publish.yml',
    job: 'publish',
    checkoutRef:
      "${{ github.event_name == 'push' && github.ref_name || inputs.release_tag != '' && inputs.release_tag || github.ref }}",
    tag:
      "${{ github.event_name == 'push' && github.ref_name || inputs.release_tag }}",
    requireTag:
      "${{ github.event_name == 'push' || !inputs.dry_run }}",
  },
  {
    file: 'pypi-publish.yml',
    job: 'build-and-publish',
    checkoutRef: '${{ steps.request.outputs.release_tag }}',
    tag: '${{ steps.request.outputs.release_tag }}',
    requireTag: true,
  },
  {
    file: 'build-vscode-sidecars.yml',
    job: 'build',
    checkoutRef:
      "${{ github.event_name == 'push' && github.ref_name || inputs.tag }}",
    tag: "${{ github.event_name == 'push' && github.ref_name || inputs.tag }}",
    requireTag: true,
  },
]

test('every release publisher binds the checked-out commit to its exact release tag', async (t) => {
  for (const expected of RELEASE_WORKFLOWS) {
    await t.test(expected.file, () => {
      const steps = workflow(expected.file).jobs[expected.job].steps
      const checkoutIndex = steps.findIndex((step) =>
        String(step.uses ?? '').startsWith('actions/checkout@'),
      )
      const sourceGateIndex = steps.findIndex(
        (step) => step.run === SOURCE_COMMAND,
      )

      assert.notEqual(checkoutIndex, -1, 'workflow checks out source')
      assert.equal(
        steps[checkoutIndex].with?.['fetch-depth'],
        0,
        'checkout must fetch tags so source identity can be proven',
      )
      assert.equal(
        steps[checkoutIndex].with?.ref,
        expected.checkoutRef,
        'publication must check out the requested release tag',
      )
      assert.ok(
        sourceGateIndex > checkoutIndex,
        'release source gate must run after checkout',
      )

      const gate = steps[sourceGateIndex]
      assert.equal(gate.name, 'Verify release source')
      assert.equal(gate.env?.RELEASE_SOURCE_TAG, expected.tag)
      assert.equal(
        gate.env?.RELEASE_SOURCE_REQUIRE_TAG,
        expected.requireTag,
      )
    })
  }
})

test('Android release signing verifies validity and the approved signer identity', () => {
  const source = readFileSync(
    resolve(ROOT, '.github/workflows/android-build.yml'),
    'utf8',
  )
  const steps = workflow('android-build.yml').jobs.android.steps
  const signing = steps.find((step) => step.name === 'Sign the APK (apksigner)')

  assert.ok(signing, 'Android workflow has a signing step')
  assert.equal(
    signing.env?.ANDROID_EXPECTED_SIGNER_SHA256,
    '${{ vars.ANDROID_SIGNING_CERT_SHA256 }}',
  )
  assert.match(signing.run, /apksigner"\s+verify\s+--verbose\s+--print-certs/)
  assert.match(signing.run, /ANDROID_EXPECTED_SIGNER_SHA256/)
  assert.match(signing.run, /ACTUAL_SIGNER_SHA256/)
  assert.match(signing.run, /exit 1/)
  assert.doesNotMatch(
    signing.run,
    /apksigner"\s+verify[^\n]*\|\|\s*true/,
    'signature verification must never be suppressed',
  )
  assert.doesNotMatch(
    source,
    /build `main` and upload the APK to an existing release tag/,
    'comments must not endorse building a different source for a release',
  )
})

test('path-filtered release workflows watch the shared source verifier', () => {
  const source = readFileSync(
    resolve(ROOT, '.github/workflows/hpc-bundle.yml'),
    'utf8',
  )
  assert.match(source, /-\s+'scripts\/verify-release-source\.mjs'/)
})
