import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

test('Node archive tests use repository-declared uv and VSCE tooling', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.equal(packageJson.devDependencies['@vscode/vsce'], '^3.9.2')

  const workflow = loadYaml(read('.github/workflows/test.yml'))
  const steps = workflow.jobs.unit.steps
  const nodeTests = steps.findIndex(
    (step) => step.name === 'Run Node script tests',
  )
  const setupUv = steps.findIndex(
    (step) =>
      step.uses ===
        'astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b' &&
      step.with?.version === '0.11.16',
  )
  const verifyTools = steps.findIndex(
    (step) =>
      step.name === 'Verify Node archive test tooling' &&
      step.run === 'uv --version\npnpm exec vsce --version\n',
  )

  assert.ok(setupUv >= 0 && setupUv < nodeTests, 'uv is installed before tests')
  assert.ok(
    verifyTools > setupUv && verifyTools < nodeTests,
    'the exact uv and workspace VSCE binaries are resolved before tests',
  )
})

test('the VSIX archive test invokes the workspace VSCE binary directly', () => {
  const archiveTest = read('scripts/__tests__/license-policy.test.mjs')
  assert.match(
    archiveTest,
    /execFileSync\(\s*resolve\(ROOT,\s*'node_modules\/\.bin\/vsce'\),\s*\[\s*'package'/,
  )
  assert.doesNotMatch(archiveTest, /execFileSync\(\s*'vsce'/)
})
