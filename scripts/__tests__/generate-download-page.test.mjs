import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import {
  buildReleaseModel,
  renderDownloadPage,
} from '../generate-download-page.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const GENERATOR = resolve(ROOT, 'scripts/generate-download-page.mjs')
const BASE_URL = 'https://dl.catgo-ucsd.org'
const TESTFLIGHT_URL = 'https://testflight.apple.com/join/FdHup5Hz'

const completeAssets = [
  { name: 'CatGo_1.4.6_x64-setup.exe', size: 328_169_059 },
  { name: 'CatGo_1.4.6_x64_en-US.msi', size: 343_330_816 },
  { name: 'CatGo_1.4.6_aarch64.dmg', size: 285_816_788 },
  { name: 'CatGo_1.4.6_amd64.deb', size: 428_621_666 },
  { name: 'CatGo-1.4.6-1.x86_64.rpm', size: 425_947_574 },
  { name: 'CatGo_1.4.6_amd64.AppImage', size: 419_430_400 },
  { name: 'CatGo-v1.4.6-android-universal.apk', size: 210_740_897 },
  { name: 'CatGo_1.4.6_x64-setup.exe.sig', size: 416 },
  { name: 'CatGo_aarch64.app.tar.gz', size: 284_425_587 },
  { name: 'catgo-1.4.6.vsix', size: 35_477_333 },
  { name: 'catgo-hpc-bundle.tar.gz', size: 34_917_426 },
  { name: 'catgo-server-linux-x64', size: 354_428_728 },
  { name: 'latest.json', size: 9_765 },
]

test('classifies a complete release and selects the preferred installer', () => {
  const model = buildReleaseModel({
    assets: completeAssets,
    tag: 'v1.4.6',
    baseUrl: BASE_URL,
  })

  assert.equal(model.version, '1.4.6')
  assert.equal(model.platforms.windows.preferred.format, 'EXE')
  assert.equal(model.platforms.windows.preferred.name, 'CatGo_1.4.6_x64-setup.exe')
  assert.deepEqual(
    model.platforms.windows.downloads.map((asset) => asset.format),
    ['EXE', 'MSI'],
  )
  assert.equal(model.platforms.macos.preferred.architecture, 'Apple Silicon')
  assert.deepEqual(
    model.platforms.linux.downloads.map((asset) => asset.format),
    ['DEB', 'RPM', 'AppImage'],
  )
  assert.equal(model.platforms.android.preferred.format, 'APK')
  assert.equal(model.platforms.ios.preferred.url, TESTFLIGHT_URL)
  assert.ok(model.other.some((asset) => asset.name.endsWith('.sig')))
  assert.ok(model.other.some((asset) => asset.name.endsWith('.vsix')))
  assert.ok(model.other.some((asset) => asset.name === 'catgo-hpc-bundle.tar.gz'))
  assert.ok(model.other.some((asset) => asset.name === 'catgo-server-linux-x64'))
  assert.equal(
    model.platforms.windows.preferred.url,
    `${BASE_URL}/v1.4.6/CatGo_1.4.6_x64-setup.exe`,
  )
})

test('renders a self-contained bilingual page with direct mirror links', () => {
  const html = renderDownloadPage(
    buildReleaseModel({
      assets: completeAssets,
      tag: 'v1.4.6',
      baseUrl: BASE_URL,
    }),
  )

  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /选择你的平台/)
  assert.match(html, /Choose your platform/)
  assert.match(html, /v1\.4\.6/)
  assert.match(html, /328\.2 MB/)
  assert.match(html, /data-platform="windows"/)
  assert.match(html, /data-platform="macos"/)
  assert.match(html, /data-platform="linux"/)
  assert.match(html, /data-platform="android"/)
  assert.match(html, /data-platform="ios"/)
  assert.match(html, new RegExp(TESTFLIGHT_URL.replaceAll('.', '\\.')))
  assert.doesNotMatch(html, /github\.com|api\.github\.com/i)
  assert.doesNotMatch(
    html,
    /<(?:script|link|img)\b[^>]+(?:src|href)=["']https?:\/\/(?!dl\.catgo-ucsd\.org|testflight\.apple\.com)/i,
  )
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(html, /:focus-visible/)
  assert.match(html, /<noscript>/)
})

test('keeps missing platforms visible without emitting broken links', () => {
  const model = buildReleaseModel({
    assets: [{ name: 'CatGo_1.4.6_x64-setup.exe', size: 1_048_576 }],
    tag: 'v1.4.6',
    baseUrl: BASE_URL,
  })
  const html = renderDownloadPage(model)

  assert.equal(model.platforms.windows.available, true)
  assert.equal(model.platforms.macos.available, false)
  assert.equal(model.platforms.linux.available, false)
  assert.equal(model.platforms.android.available, false)
  assert.equal(model.platforms.ios.available, true)
  assert.match(html, /macOS[\s\S]*?构建暂未提供/)
  assert.match(html, /Linux[\s\S]*?Build not available yet/)
  assert.match(html, /href="#other-downloads"/)
  assert.match(html, /id="other-downloads"/)
  assert.doesNotMatch(html, /href=""/)
  assert.doesNotMatch(html, /href="undefined"/)
})

test('keeps unrelated or unsupported architecture binaries out of platform cards', () => {
  const unexpected = [
    { name: 'helper_x64.exe', size: 10 },
    { name: 'CatGo_1.4.6_x64.dmg', size: 20 },
    { name: 'CatGo-v1.4.6-android-arm64.apk', size: 30 },
  ]
  const model = buildReleaseModel({
    assets: unexpected,
    tag: 'v1.4.6',
    baseUrl: BASE_URL,
  })

  assert.equal(model.platforms.windows.available, false)
  assert.equal(model.platforms.macos.available, false)
  assert.equal(model.platforms.android.available, false)
  assert.deepEqual(
    model.other.map((asset) => asset.name),
    unexpected
      .map((asset) => asset.name)
      .sort((left, right) => left.localeCompare(right)),
  )
})

test('escapes display text, encodes URL segments, and rejects unsafe inputs', () => {
  const hostileName = `catgo-<script>alert('x')</script>.vsix`
  const model = buildReleaseModel({
    assets: [{ name: hostileName, size: 42 }],
    tag: 'v1.4.6',
    baseUrl: BASE_URL,
  })
  const html = renderDownloadPage(model)

  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/)
  assert.match(
    html,
    /catgo-%3Cscript%3Ealert\(&#39;x&#39;\)%3C%2Fscript%3E\.vsix/,
  )

  for (const tag of ['', '.', '..', '../v1.4.6', 'v1.4.6/extra', 'v1\u0000.4.6']) {
    assert.throws(
      () => buildReleaseModel({ assets: [], tag, baseUrl: BASE_URL }),
      /release tag/i,
    )
  }
  assert.throws(
    () =>
      buildReleaseModel({
        assets: [],
        tag: 'v1.4.6',
        baseUrl: 'http://dl.catgo-ucsd.org',
      }),
    /HTTPS/i,
  )
})

test('CLI inventories an asset directory and writes index.html', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'catgo-download-page-'))
  const assetsDir = join(scratch, 'dist')
  const output = join(scratch, 'index.html')

  try {
    mkdirSync(assetsDir)
    writeFileSync(join(assetsDir, 'CatGo_1.4.6_x64-setup.exe'), 'installer')
    writeFileSync(join(assetsDir, 'CatGo_1.4.6_aarch64.dmg'), 'dmg')

    execFileSync(
      process.execPath,
      [
        GENERATOR,
        '--assets-dir',
        assetsDir,
        '--tag',
        'v1.4.6',
        '--base-url',
        BASE_URL,
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    )

    const html = readFileSync(output, 'utf8')
    assert.match(html, /CatGo_1\.4\.6_x64-setup\.exe/)
    assert.match(html, /CatGo_1\.4\.6_aarch64\.dmg/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
