import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (path) => readFileSync(resolve(ROOT, path), 'utf8')

const LINKS_PATH = resolve(ROOT, 'src/lib/download-links.ts')
const DOWNLOAD_HUB = 'https://dl.catgo-ucsd.org/'
const UPDATE_MANIFEST = 'https://dl.catgo-ucsd.org/latest.json'
const TESTFLIGHT = 'https://testflight.apple.com/join/FdHup5Hz'
const ENTRYPOINTS = [
  'src/lib/DesktopDownloadModal.svelte',
  'src/lib/StaticModeBanner.svelte',
  'src/lib/api/config.ts',
  'src/lib/update/auto-update.svelte.ts',
]

test('defines one source of truth for public download destinations', () => {
  assert.ok(existsSync(LINKS_PATH), 'src/lib/download-links.ts exists')
  const links = source('src/lib/download-links.ts')

  assert.match(links, /export const DOWNLOAD_HUB_URL/)
  assert.match(links, new RegExp(DOWNLOAD_HUB.replaceAll('.', '\\.')))
  assert.match(links, /export const UPDATE_MANIFEST_URL/)
  assert.match(links, new RegExp(UPDATE_MANIFEST.replaceAll('.', '\\.')))
  assert.match(links, /export const TESTFLIGHT_URL/)
  assert.match(links, new RegExp(TESTFLIGHT.replaceAll('.', '\\.')))
})

test('normal app download and update entry points contain no GitHub path', () => {
  const combined = ENTRYPOINTS.map(source).join('\n')

  assert.doesNotMatch(combined, /api\.github\.com/i)
  assert.doesNotMatch(
    combined,
    /github\.com\/Hello-QM\/catgo-LRG\/releases/i,
  )
  assert.doesNotMatch(combined, /browser_download_url/)
  assert.match(source(ENTRYPOINTS[0]), /DOWNLOAD_HUB_URL/)
  assert.match(source(ENTRYPOINTS[0]), /TESTFLIGHT_URL/)
  assert.match(source(ENTRYPOINTS[1]), /DOWNLOAD_HUB_URL/)
  assert.match(source(ENTRYPOINTS[2]), /DOWNLOAD_HUB_URL/)
  assert.match(source(ENTRYPOINTS[3]), /UPDATE_MANIFEST_URL/)
  assert.match(source(ENTRYPOINTS[3]), /parse_release_manifest/)
})

test('Tauri updater has exactly one Cloudflare manifest endpoint', () => {
  const config = JSON.parse(source('src-tauri/tauri.conf.json'))
  assert.deepEqual(config.plugins.updater.endpoints, [UPDATE_MANIFEST])
})

test('desktop choices open the hub while iOS remains on TestFlight', () => {
  const modal = source('src/lib/DesktopDownloadModal.svelte')

  assert.match(modal, /os === `ios`/)
  assert.match(modal, /TESTFLIGHT_URL/)
  assert.match(modal, /platform-\$\{hub_platform\}/)
  assert.doesNotMatch(modal, /fetch\s*\(/)
})
