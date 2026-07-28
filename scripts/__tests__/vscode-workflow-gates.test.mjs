import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function workflow(name) {
  return loadYaml(
    readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8'),
  )
}

function activeStepIndex(steps, command, workingDirectory) {
  return steps.findIndex(
    (step) =>
      step.if !== false &&
      typeof step.run === 'string' &&
      step.run.includes(command) &&
      (
        workingDirectory === undefined ||
        step['working-directory'] === workingDirectory
      ),
  )
}

const EXTENSION_TEST = 'pnpm exec vitest run'
const EXTENSION_TYPECHECK = 'pnpm exec tsc --noEmit'

test('main CI executes the VS Code security suite and typecheck', () => {
  const steps = workflow('test.yml').jobs.unit.steps

  for (const command of [EXTENSION_TEST, EXTENSION_TYPECHECK]) {
    const index = activeStepIndex(steps, command, 'extensions/vscode')
    assert.notEqual(index, -1, `test.yml must actively run: ${command}`)
    assert.equal(steps[index]['working-directory'], 'extensions/vscode')
  }
})

test('VSIX publishing gates packaging on extension tests and typecheck', () => {
  const steps = workflow('vsix-publish.yml').jobs.publish.steps
  const testIndex = activeStepIndex(
    steps,
    EXTENSION_TEST,
    'extensions/vscode',
  )
  const typecheckIndex = activeStepIndex(
    steps,
    EXTENSION_TYPECHECK,
    'extensions/vscode',
  )
  const packageIndex = activeStepIndex(
    steps,
    'pnpm dlx @vscode/vsce package --no-dependencies',
  )
  const firstPublicationIndex = steps.findIndex(
    (step) =>
      typeof step.run === 'string' &&
      /(vsce|ovsx) publish/.test(step.run),
  )

  assert.notEqual(testIndex, -1, 'VSIX workflow must run extension tests')
  assert.notEqual(
    typecheckIndex,
    -1,
    'VSIX workflow must run the extension typecheck',
  )
  assert.ok(testIndex < packageIndex, 'extension tests must precede packaging')
  assert.ok(
    typecheckIndex < packageIndex,
    'extension typecheck must precede packaging',
  )
  assert.ok(packageIndex < firstPublicationIndex, 'packaging must precede publish')
})
