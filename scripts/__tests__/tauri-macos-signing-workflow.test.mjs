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
  "runner.os == 'macOS' && (startsWith(github.ref, 'refs/tags/') || inputs.release)"
const REQUIRED_SIGNING_SECRETS = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'MACOS_CERTIFICATE',
  'MACOS_CERTIFICATE_PASSWORD',
  'MACOS_SIGNING_IDENTITY',
  'APPLE_DEVELOPMENT_TEAM',
]

function workflowSteps() {
  return loadYaml(readFileSync(WORKFLOW_PATH, 'utf8')).jobs.build.steps
}

function stepNamed(steps, name) {
  return steps.find((step) => step.name === name)
}

test('release macOS builds fail closed before Tauri when any signing secret is absent', () => {
  const steps = workflowSteps()
  const preflight = stepNamed(steps, 'Preflight macOS release signing')
  const buildIndex = steps.findIndex(
    (step) => step.uses === 'tauri-apps/tauri-action@v0.6',
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
    (step) => step.uses === 'tauri-apps/tauri-action@v0.6',
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

