import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEPLOY_WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/deploy-cloudflare.yml'),
  'utf8',
)
const WASM_PACK_INSTALL =
  'curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh'
const DOWNLOADS_CONFIG_PATH = resolve(ROOT, 'wrangler.downloads.toml')
const DEPLOY_CONFIG = loadYaml(DEPLOY_WORKFLOW)

test('Cloudflare app deployment installs a wasm-pack that supports feature flags', () => {
  assert.doesNotMatch(DEPLOY_WORKFLOW, /jetli\/wasm-pack-action/)
  assert.match(DEPLOY_WORKFLOW, /- name: Install wasm-pack/)
  assert.ok(DEPLOY_WORKFLOW.includes(`run: ${WASM_PACK_INSTALL}`))
})

test('Cloudflare workflow deploys the download Worker', () => {
  assert.match(DEPLOY_WORKFLOW, /workers\/downloads\/\*\*/)
  assert.match(DEPLOY_WORKFLOW, /wrangler\.downloads\.toml/)
  assert.match(DEPLOY_WORKFLOW, /deploy-downloads:/)
  assert.match(DEPLOY_WORKFLOW, /name: Deploy dl\.catgo-ucsd\.org/)
  assert.match(
    DEPLOY_WORKFLOW,
    /command: deploy --config wrangler\.downloads\.toml/,
  )
})

test('download deployment provisions pnpm before Wrangler runs', () => {
  const steps = DEPLOY_CONFIG.jobs['deploy-downloads'].steps
  const pnpmIndex = steps.findIndex(
    (step) => step.uses === 'pnpm/action-setup@v4',
  )
  const wranglerIndex = steps.findIndex(
    (step) => step.uses === 'cloudflare/wrangler-action@v3',
  )

  assert.notEqual(pnpmIndex, -1, 'download deployment installs pnpm')
  assert.notEqual(wranglerIndex, -1, 'download deployment invokes Wrangler')
  assert.ok(pnpmIndex < wranglerIndex, 'pnpm is available before Wrangler starts')
})

test('every Cloudflare deployment pins the validated Wrangler release', () => {
  const deployJobs = ['deploy-docs', 'deploy-app', 'deploy-downloads']
  const wranglerSteps = deployJobs.map((jobName) => {
    const steps = DEPLOY_CONFIG.jobs[jobName].steps
    const matches = steps.filter(
      (step) => step.uses === 'cloudflare/wrangler-action@v3',
    )
    assert.equal(matches.length, 1, `${jobName} has one Wrangler action`)
    return [jobName, matches[0]]
  })

  assert.equal(wranglerSteps.length, 3)
  for (const [jobName, step] of wranglerSteps) {
    assert.equal(
      step.with.wranglerVersion,
      '4.90.1',
      `${jobName} pins the validated Wrangler release`,
    )
  }
})

test('download Worker config binds the releases bucket to the domain route', () => {
  assert.ok(existsSync(DOWNLOADS_CONFIG_PATH), 'wrangler.downloads.toml exists')
  const config = readFileSync(DOWNLOADS_CONFIG_PATH, 'utf8')

  assert.match(config, /name = "catgo-downloads"/)
  assert.match(config, /main = "workers\/downloads\/index\.mjs"/)
  assert.match(config, /pattern = "dl\.catgo-ucsd\.org\/\*"/)
  assert.match(config, /zone_name = "catgo-ucsd\.org"/)
  assert.match(config, /binding = "RELEASES"/)
  assert.match(config, /bucket_name = "catgo-releases"/)
})
