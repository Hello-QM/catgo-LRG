import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/tauri-build.yml')
const RELEASE_MACOS_CONDITION =
  "runner.os == 'macOS' && env.CATGO_RELEASE_TAG != ''"
const REQUIRED_SIGNING_SECRETS = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'MACOS_CERTIFICATE',
  'MACOS_CERTIFICATE_PASSWORD',
  'MACOS_SIGNING_IDENTITY',
  'APPLE_DEVELOPMENT_TEAM',
]

function workflow() {
  return loadYaml(readFileSync(WORKFLOW_PATH, 'utf8'))
}

function workflowSteps() {
  return workflow().jobs.build.steps
}

function stepNamed(steps, name) {
  return steps.find((step) => step.name === name)
}

test('branch dispatch is smoke-only while tag push or dispatch publishes exact source', () => {
  const current = workflow()
  const steps = workflowSteps()
  const sourceGate = stepNamed(steps, 'Verify release source')
  const eventIdentity = stepNamed(steps, 'Verify tag event source identity')
  const smoke = stepNamed(steps, 'Build Tauri app (no release)')
  const release = stepNamed(steps, 'Build and upload Tauri release')

  assert.equal(current.on.workflow_dispatch.inputs.release_tag.type, 'string')
  assert.equal(current.on.workflow_dispatch.inputs.windows_only.type, 'boolean')
  assert.ok(sourceGate)
  assert.equal(
    sourceGate.env.RELEASE_SOURCE_TAG,
    "${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || inputs.release_tag }}",
  )
  assert.equal(
    sourceGate.env.RELEASE_SOURCE_REQUIRE_TAG,
    "${{ startsWith(github.ref, 'refs/tags/') || inputs.release_tag != '' }}",
  )
  assert.ok(eventIdentity)
  assert.equal(eventIdentity.if, "env.CATGO_RELEASE_TAG != ''")
  assert.match(eventIdentity.run, /git rev-parse HEAD\^\{commit\}/)
  assert.match(eventIdentity.run, /git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"/)
  assert.match(eventIdentity.run, /GITHUB_SHA/)

  assert.ok(smoke)
  assert.equal(
    smoke.if,
    "env.CATGO_RELEASE_TAG == ''",
  )
  assert.deepEqual(Object.keys(smoke.with).sort(), ['args'])

  assert.ok(release)
  assert.equal(
    release.if,
    "env.CATGO_RELEASE_TAG != ''",
  )
  assert.equal(release.with.tagName, '${{ env.CATGO_RELEASE_TAG }}')
  assert.equal(release.with.releaseDraft, true)
})

test('release macOS builds fail closed before Tauri when any signing secret is absent', () => {
  const steps = workflowSteps()
  const preflight = stepNamed(steps, 'Preflight macOS release signing')
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Build and upload Tauri release',
  )
  const preflightIndex = steps.indexOf(preflight)

  assert.ok(preflight, 'macOS release signing has a preflight step')
  assert.ok(
    preflightIndex > -1 && preflightIndex < buildIndex,
    'signing preflight runs before tauri-action can create release artifacts',
  )
  assert.equal(preflight.if, RELEASE_MACOS_CONDITION)

  for (const secret of REQUIRED_SIGNING_SECRETS) {
    assert.equal(preflight.env[secret], `\${{ secrets.${secret} }}`)
  }

  const missing = spawnSync('bash', ['-c', preflight.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })
  assert.notEqual(missing.status, 0)
  for (const secret of REQUIRED_SIGNING_SECRETS) {
    assert.match(missing.stderr, new RegExp(`Missing required secret: ${secret}`))
  }

  const present = spawnSync('bash', ['-c', preflight.run], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...Object.fromEntries(
        REQUIRED_SIGNING_SECRETS.map((secret) => [secret, 'configured']),
      ),
    },
  })
  assert.equal(present.status, 0, present.stderr)
})

test('release macOS builds verify the produced app and the app mounted from the DMG', () => {
  const steps = workflowSteps()
  const verify = stepNamed(steps, 'Verify macOS release signatures')
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Build and upload Tauri release',
  )
  const verifyIndex = steps.indexOf(verify)

  assert.ok(verify, 'macOS release artifacts have a post-build verifier')
  assert.ok(
    verifyIndex > buildIndex,
    'artifact signature verification runs after Tauri builds the app and DMG',
  )
  assert.equal(verify.if, RELEASE_MACOS_CONDITION)
  assert.equal(
    verify.env.MACOS_SIGNING_IDENTITY,
    '${{ secrets.MACOS_SIGNING_IDENTITY }}',
  )
  assert.equal(
    verify.env.APPLE_DEVELOPMENT_TEAM,
    '${{ secrets.APPLE_DEVELOPMENT_TEAM }}',
  )

  assert.match(verify.run, /codesign --verify --deep --strict/)
  assert.match(verify.run, /hdiutil attach/)
  assert.match(verify.run, /hdiutil detach/)
  assert.match(verify.run, /Authority=\$MACOS_SIGNING_IDENTITY/)
  assert.match(verify.run, /TeamIdentifier=\$APPLE_DEVELOPMENT_TEAM/)
})

test('uploads a hash-bound macOS signing attestation only after remote artifacts match', () => {
  const steps = workflowSteps()
  const verify = stepNamed(steps, 'Verify macOS release signatures')
  const upload = stepNamed(steps, 'Upload macOS signing attestation')
  const verifyIndex = steps.indexOf(verify)
  const uploadIndex = steps.indexOf(upload)

  assert.equal(verify.id, 'macos_signing')
  assert.equal(verify.if, RELEASE_MACOS_CONDITION)
  assert.match(verify.run, /gh release download "\$RELEASE_TAG"/)
  assert.match(verify.run, /shasum -a 256/)
  assert.match(verify.run, /local_dmg_sha.*remote_dmg_sha/s)
  assert.match(
    verify.run,
    /verify-macos-signing-attestation\.mjs[\s\S]*--tag "\$RELEASE_TAG"[\s\S]*--source-commit "\$source_commit"/,
  )
  assert.match(verify.run, /"githubRunId"/)
  assert.match(verify.run, /"signer"/)
  assert.match(verify.run, /"teamIdentifier"/)

  assert.ok(upload, 'the verified attestation has a dedicated upload boundary')
  assert.ok(uploadIndex > verifyIndex)
  assert.equal(upload.if, RELEASE_MACOS_CONDITION)
  assert.equal(
    upload.env.ATTESTATION_PATH,
    '${{ steps.macos_signing.outputs.attestation }}',
  )
  assert.match(
    upload.run,
    /gh release upload "\$RELEASE_TAG" "\$ATTESTATION_PATH"[\s\S]*--clobber/,
  )
})

test('verifies the app inside the remote updater archive before attestation', () => {
  const verify = stepNamed(
    workflowSteps(),
    'Verify macOS release signatures',
  )
  const downloadIndex = verify.run.indexOf('gh release download')
  const extractIndex = verify.run.indexOf('tar -xzf')
  const uniqueAppIndex = verify.run.indexOf(
    'Expected exactly one app inside updater archive',
  )
  const signatureIndex = verify.run.indexOf(
    'verify_app_signature "${updater_apps[0]}"',
  )
  const attestationIndex = verify.run.indexOf('attestation=')

  assert.ok(downloadIndex >= 0)
  assert.ok(extractIndex > downloadIndex)
  assert.ok(uniqueAppIndex > extractIndex)
  assert.ok(signatureIndex > uniqueAppIndex)
  assert.ok(attestationIndex > signatureIndex)
})
