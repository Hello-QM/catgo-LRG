import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEPLOY_WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/deploy-cloudflare.yml'),
  'utf8',
)
const WASM_PACK_INSTALL =
  'curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh'

test('Cloudflare app deployment installs a wasm-pack that supports feature flags', () => {
  assert.doesNotMatch(DEPLOY_WORKFLOW, /jetli\/wasm-pack-action/)
  assert.match(DEPLOY_WORKFLOW, /- name: Install wasm-pack/)
  assert.ok(DEPLOY_WORKFLOW.includes(`run: ${WASM_PACK_INSTALL}`))
})
