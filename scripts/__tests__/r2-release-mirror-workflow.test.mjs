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

test('keeps triggers but resolves only validated CatGo app releases', () => {
  assert.match(WORKFLOW, /release:\s*\n\s+types:\s*\[published\]/)
  assert.match(WORKFLOW, /workflow_dispatch:/)
  assert.match(WORKFLOW, /APP_TAG_PATTERN:/)
  assert.match(WORKFLOW, /releases\?per_page=100/)
  assert.match(WORKFLOW, /sort -V/)
  assert.match(WORKFLOW, /startsWith\(github\.event\.release\.tag_name, 'v'\)/)
  assert.doesNotMatch(WORKFLOW, /repos\/\$\{\{ github\.repository \}\}\/releases\/latest/)
  assert.match(WORKFLOW, /group: r2-release-mirror/)
})

test('never interpolates event or output tags into secrets-bearing shell', () => {
  assert.match(WORKFLOW, /RELEASE_EVENT_TAG:\s*\$\{\{ github\.event\.release\.tag_name \}\}/)
  assert.match(WORKFLOW, /REQUESTED_TAG:\s*\$\{\{ inputs\.tag \}\}/)
  assert.match(WORKFLOW, /MIRROR_TAG:\s*\$\{\{ steps\.tag\.outputs\.tag \}\}/)
  assert.doesNotMatch(
    WORKFLOW,
    /tag\s*=\s*['"]\$\{\{\s*(?:github\.event\.release\.tag_name|inputs\.tag|steps\.tag\.outputs\.tag)\s*\}\}/,
  )
  assert.match(WORKFLOW, /\[\[ "\$tag" =~ \$APP_TAG_PATTERN \]\]/)
})

test('manual old-tag backfills cannot replace public root metadata', () => {
  const syncStart = WORKFLOW.indexOf('- name: Sync to R2')
  const pruneStart = WORKFLOW.indexOf('- name: Prune older releases')
  const syncBlock = WORKFLOW.slice(syncStart, pruneStart)

  assert.match(syncBlock, /latest_app_tag=/)
  assert.match(
    syncBlock,
    /if \[ "\$tag" = "\$latest_app_tag" \]; then[\s\S]*aws s3 cp latest\.mirror\.json[\s\S]*aws s3 cp index\.html[\s\S]*fi/,
  )
})
