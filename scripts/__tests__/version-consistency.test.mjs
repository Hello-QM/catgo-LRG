import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const APP_VERSION = '1.4.6'
const PYTHON_VERSION = `${APP_VERSION}.post1`

function tomlSectionVersion(path, section) {
  const content = source(path)
  const match = new RegExp(
    `^\\[${section.replaceAll('.', '\\\\.')}\\][\\s\\S]*?^version\\s*=\\s*"([^"]+)"`,
    'm',
  ).exec(content)
  assert.ok(match, `${path} has a version in [${section}]`)
  return match[1]
}

function cffVersion(path) {
  const match = /^version:\s*(\S+)$/m.exec(source(path))
  assert.ok(match, `${path} has a top-level version`)
  return match[1]
}

function workflowStep(path, name) {
  const workflow = source(path)
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `${path} has the "${name}" step`)
  const next = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, next === -1 ? undefined : next)
}

test('all CatGo application version surfaces target v1.4.6', () => {
  const packageJson = JSON.parse(source('package.json'))
  const tauriConfig = JSON.parse(source('src-tauri/tauri.conf.json'))
  const cargoLockMatch =
    /^\[\[package\]\]\nname = "catgo"\nversion = "([^"]+)"/m.exec(
      source('src-tauri/Cargo.lock'),
    )

  assert.equal(packageJson.version, APP_VERSION)
  assert.equal(tauriConfig.version, APP_VERSION)
  assert.equal(
    tomlSectionVersion('src-tauri/Cargo.toml', 'package'),
    APP_VERSION,
  )
  assert.ok(cargoLockMatch, 'src-tauri/Cargo.lock contains the catgo package')
  assert.equal(cargoLockMatch[1], APP_VERSION)
  assert.equal(
    tomlSectionVersion('server/pyproject.toml', 'project'),
    PYTHON_VERSION,
  )
})

test('VSIX and citation package metadata target v1.4.6', () => {
  const vscodePackage = JSON.parse(source('extensions/vscode/package.json'))
  assert.equal(vscodePackage.version, APP_VERSION)

  for (const path of [
    'CITATION.cff',
    'extensions/rust-wasm/CITATION.cff',
    'extensions/vscode/CITATION.cff',
    'server/CITATION.cff',
  ]) {
    assert.equal(cffVersion(path), APP_VERSION, path)
  }
})

test('the dependency lock remains a pnpm v9 root-importer lock', () => {
  const lock = source('pnpm-lock.yaml')

  assert.match(lock, /^lockfileVersion:\s*'9\.0'$/m)
  assert.match(lock, /^importers:\n\n  \.:\n/m)
})

test('the desktop draft release notes describe v1.4.6', () => {
  const workflow = source('.github/workflows/tauri-build.yml')

  assert.match(workflow, /### New in 1\.4\.6/)
  assert.match(workflow, /at least 24 unique presented frames per second/)
  assert.match(workflow, /GPU impostor bonds/)
  assert.match(workflow, /Gaussian frame counting and IRC trajectories/)
  assert.match(workflow, /China-friendly all-platform download center/)
  assert.match(workflow, /Cloudflare-only app acquisition and updates/)
})

test('VSIX publishing verifies the release version and fails on duplicates', () => {
  const verifyStep = workflowStep(
    '.github/workflows/vsix-publish.yml',
    'Verify extension release version',
  )
  assert.match(verifyStep, /test "\$extension_ver" = "\$root_ver"/)
  assert.match(verifyStep, /test "\$GITHUB_REF_NAME" = "v\$root_ver"/)

  const marketplaceStep = workflowStep(
    '.github/workflows/vsix-publish.yml',
    'Publish to VS Code Marketplace',
  )
  const openVsxStep = workflowStep(
    '.github/workflows/vsix-publish.yml',
    'Publish to Open VSX (Cursor / VSCodium / Theia)',
  )
  for (const step of [marketplaceStep, openVsxStep]) {
    assert.doesNotMatch(step, /set \+e/)
    assert.doesNotMatch(step, /already \(exists\|published\)/)
    assert.doesNotMatch(step, /treating as a no-op/i)
  }
})

test('PyPI publishing does not skip an already-used Python version', () => {
  const publishStep = workflowStep(
    '.github/workflows/pypi-publish.yml',
    'Publish to PyPI',
  )
  assert.doesNotMatch(publishStep, /skip-existing:\s*true/)
})
