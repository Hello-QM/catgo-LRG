import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/r2-release-mirror.yml'),
  'utf8',
)

const APP_RELEASE_WORKFLOWS = [
  'Build Desktop App',
  'Android build',
  'Build HPC Bundle',
  'Publish VSCode Extension',
  'Build VSCode Sidecar Binaries',
]

test('refreshes the mirror after every CatGo release-asset workflow', () => {
  assert.match(WORKFLOW, /workflow_run:/)
  assert.match(WORKFLOW, /types:\s*\[completed\]/)
  for (const workflowName of APP_RELEASE_WORKFLOWS) {
    assert.match(WORKFLOW, new RegExp(`- ${workflowName.replaceAll(' ', '\\s+')}`))
  }
  assert.doesNotMatch(WORKFLOW, /^\s*-\s+Build STT accelerator\s*$/m)
  assert.match(
    WORKFLOW,
    /github\.event\.workflow_run\.conclusion == 'success'/,
  )
})

test('checks out trusted source and generates the page with the Node CLI', () => {
  assert.match(WORKFLOW, /uses: actions\/checkout@v4/)
  assert.match(
    WORKFLOW,
    /node scripts\/generate-download-page\.mjs[\s\S]*--assets-dir dist[\s\S]*--tag "\$tag"[\s\S]*--base-url "\$R2_PUBLIC_BASE_URL"[\s\S]*--output index\.html/,
  )
  assert.doesNotMatch(WORKFLOW, /echo '<!doctype html>/)
  assert.doesNotMatch(WORKFLOW, /github\.com\/\$\{\{ github\.repository \}\}\/releases/)
})

test('rewrites and validates every updater URL before publishing metadata', () => {
  assert.match(WORKFLOW, /Rewrite and validate latest\.json URLs/)
  assert.match(WORKFLOW, /startsWith|startswith/)
  assert.match(WORKFLOW, /jq \. latest\.mirror\.json > \/dev\/null/)

  const syncAssets = WORKFLOW.indexOf('aws s3 sync dist/')
  const uploadManifest = WORKFLOW.indexOf('aws s3 cp latest.mirror.json')
  const uploadIndex = WORKFLOW.indexOf('aws s3 cp index.html')
  const prune = WORKFLOW.indexOf('- name: Prune older releases')

  assert.ok(syncAssets >= 0, 'release assets are uploaded')
  assert.ok(uploadManifest > syncAssets, 'latest.json uploads after release assets')
  assert.ok(uploadIndex > uploadManifest, 'index.html uploads after latest.json')
  assert.ok(prune > uploadIndex, 'pruning starts only after root metadata uploads')
})

test('keeps release/manual triggers and resolves workflow runs to latest', () => {
  assert.match(WORKFLOW, /release:\s*\n\s+types:\s*\[published\]/)
  assert.match(WORKFLOW, /workflow_dispatch:/)
  assert.match(
    WORKFLOW,
    /github\.event_name.*workflow_run[\s\S]*releases\/latest/,
  )
  assert.match(WORKFLOW, /group: r2-release-mirror/)
})
