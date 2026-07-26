import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const workflow = source('.github/workflows/build-vscode-sidecars.yml')

function workflowStep(name) {
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `sidecar workflow has the "${name}" step`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? undefined : next)
}

test('sidecar publishing requires the exact application release tag', () => {
  assert.match(
    workflow,
    /tag:[\s\S]*?required:\s*true/,
    'manual sidecar publishing requires an explicit tag',
  )

  const step = workflowStep('Verify release version')
  assert.match(step, /node scripts\/verify-release-version\.mjs/)
  assert.match(step, /RELEASE_VERSION_TAG:/)
  assert.match(step, /github\.ref_name/)
  assert.match(step, /inputs\.tag/)
  assert.match(step, /RELEASE_VERSION_REQUIRE_TAG:\s*true/)
})

test('sidecar publishing uploads strict SHA-256 metadata beside every binary', () => {
  const checksumStep = workflowStep('Generate SHA-256 checksum')
  assert.match(checksumStep, /createHash\(['"]sha256['"]\)/)
  assert.match(checksumStep, /\$\{\{\s*matrix\.asset_name\s*\}\}\.sha256/)
  assert.match(checksumStep, /\$\{digest\}  \$\{basename\(file\)\}\\n/)

  const uploadStep = workflowStep('Attach sidecar to GitHub Release')
  assert.match(uploadStep, /"\$\{\{\s*matrix\.asset_name\s*\}\}"/)
  assert.match(uploadStep, /"\$\{\{\s*matrix\.asset_name\s*\}\}\.sha256"/)
})

test('sidecar archive verification excludes the sync ownership sentinel', () => {
  const step = workflowStep('Verify embedded legal bundle')
  assert.match(step, /find build\/legal-bundle -type f/)
  assert.match(
    step,
    /! -name ['"]\.catgo-legal-bundle-owned['"]/,
    'the ownership sentinel is not a redistributed legal document',
  )
})

test('pnpm is canonical and no nested npm lock can silently drift', () => {
  const rootPackage = JSON.parse(source('package.json'))
  assert.match(rootPackage.packageManager, /^pnpm@/)
  assert.equal(
    existsSync(resolve(ROOT, 'extensions/vscode/package-lock.json')),
    false,
    'extensions/vscode/package-lock.json must stay deleted',
  )
})

test('the unused static download page cannot shadow the Worker-generated hub', () => {
  assert.equal(
    existsSync(resolve(ROOT, 'deploy/download/index.html')),
    false,
    'legacy deploy/download/index.html must stay deleted',
  )
  assert.ok(existsSync(resolve(ROOT, 'scripts/generate-download-page.mjs')))
  assert.ok(existsSync(resolve(ROOT, 'workers/downloads/index.mjs')))
})
