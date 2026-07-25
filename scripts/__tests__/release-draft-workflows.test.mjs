import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (path) => readFileSync(resolve(ROOT, path), 'utf8')

const APP_ASSET_WORKFLOWS = [
  '.github/workflows/vsix-publish.yml',
  '.github/workflows/build-vscode-sidecars.yml',
]

test('auxiliary app asset workflows may create only draft releases', () => {
  for (const path of APP_ASSET_WORKFLOWS) {
    const createLines = source(path)
      .split('\n')
      .filter((line) => line.includes('gh release create'))

    assert.ok(createLines.length > 0, `${path} contains a release fallback`)
    for (const line of createLines) {
      assert.match(line, /--draft(?:\s|$)/, `${path}: ${line.trim()}`)
    }
  }

  assert.match(source('.github/workflows/tauri-build.yml'), /releaseDraft:\s*true/)
})

test('the independent STT release can never become GitHub latest', () => {
  const createLines = source('.github/workflows/build-stt-accel.yml')
    .split('\n')
    .filter((line) => line.includes('gh release create'))

  assert.ok(createLines.length > 0)
  for (const line of createLines) {
    assert.match(line, /--latest=false(?:\s|$)/)
  }
})
