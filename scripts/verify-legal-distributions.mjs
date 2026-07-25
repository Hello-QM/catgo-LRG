#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import {
  ACKNOWLEDGEMENT,
  legalBundleSources,
  ROOT,
} from './sync-legal-bundle.mjs'

const CLASSES = [
  'android-apk-aab',
  'docker-image',
  'github-release',
  'hpc-bundle',
  'ios-ipa-testflight',
  'stt-accelerator-archives',
  'tauri-desktop-bundles',
  'vscode-sidecar-binaries',
  'web-app-static',
  'web-docs-static',
]

const APPLICATION_WORKFLOWS = new Set([
  'android-build.yml',
  'build-stt-accel.yml',
  'build-vscode-sidecars.yml',
  'deploy-cloudflare.yml',
  'docker-publish.yml',
  'hpc-bundle.yml',
  'ios-build.yml',
  'r2-release-mirror.yml',
  'tauri-build.yml',
  'tauri-test-build.yml',
])

// Package archives have their own archive-content gate in license-policy.test.mjs.
// Keeping the two owners explicit makes a newly added publisher fail discovery.
const PACKAGE_ARCHIVE_WORKFLOWS = new Set([
  'pypi-publish.yml',
  'vsix-publish.yml',
])

const DISTRIBUTION_MARKER =
  /upload-artifact|gh release upload|action-gh-release|tauri-action|gh-action-pypi-publish|vsce publish|ovsx publish|build-push-action|wrangler-action|aws s3 sync/

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

function requireMatch(path, pattern, explanation) {
  assert.match(read(path), pattern, `${path}: ${explanation}`)
}

function discoverDistributionWorkflows() {
  const workflowDir = resolve(ROOT, '.github/workflows')
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) =>
      DISTRIBUTION_MARKER.test(
        readFileSync(resolve(workflowDir, name), 'utf8'),
      ),
    )
    .sort()
}

function verifySources() {
  assert.match(read('license'), new RegExp(ACKNOWLEDGEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(read('CITATION.cff'), new RegExp(ACKNOWLEDGEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const source of legalBundleSources()) read(source)
}

function verifyDiscovery() {
  const discovered = discoverDistributionWorkflows()
  const owned = new Set([
    ...APPLICATION_WORKFLOWS,
    ...PACKAGE_ARCHIVE_WORKFLOWS,
  ])
  assert.deepEqual(
    discovered.filter((name) => !owned.has(name)),
    [],
    'new distribution workflows must stage a legal bundle and declare an owner',
  )
  for (const expected of owned) {
    assert.ok(
      discovered.includes(expected),
      `${expected}: declared distribution workflow no longer publishes`,
    )
  }
}

function verifyBuildEntryPoints() {
  const scripts = JSON.parse(read('package.json')).scripts
  for (const name of ['desktop:build', 'deploy:build', 'docs:build']) {
    assert.match(
      scripts[name],
      /^pnpm legal:sync &&/,
      `package.json scripts.${name} must sync before building`,
    )
  }
  assert.equal(
    scripts['legal:sync'],
    'node scripts/sync-legal-bundle.mjs',
  )
  assert.equal(
    scripts['legal:verify'],
    'node scripts/verify-legal-distributions.mjs',
  )
}

function verifyTauriAndMobile() {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  assert.equal(
    config.bundle.resources['resources/legal/'],
    'legal/',
    'Tauri resources must map the staged directory to $RESOURCE/legal',
  )
  assert.match(
    config.build.beforeBuildCommand,
    /desktop:build/,
    'all Tauri targets must use the legal-synchronizing build entry point',
  )

  requireMatch(
    '.github/workflows/android-build.yml',
    /Verify legal bundle in APK\/AAB[\s\S]*unzip -Z1[\s\S]*\/legal\/\$rel[\s\S]*find build\/legal-bundle/,
    'inspect the built APK/AAB before upload',
  )
  requireMatch(
    '.github/workflows/ios-build.yml',
    /Verify legal bundle in iOS artifacts[\s\S]*unzip -Z1[\s\S]*\/legal\/\$rel[\s\S]*find build\/legal-bundle/,
    'inspect the built IPA before TestFlight/upload',
  )
  requireMatch(
    '.github/workflows/tauri-build.yml',
    /pnpm legal:verify/,
    'verify staged desktop resources before tauri-action',
  )
}

function verifyWebDistributions() {
  requireMatch(
    'wrangler.app.toml',
    /directory = "\.\/build-desktop"/,
    'app deployment must publish the legal-synchronized build directory',
  )
  requireMatch(
    'wrangler.docs.toml',
    /directory = "\.\/docs\/\.vitepress\/dist"/,
    'docs deployment must publish the legal-synchronized build directory',
  )
  requireMatch(
    '.github/workflows/deploy-cloudflare.yml',
    /pnpm legal:verify/,
    'Cloudflare deployments must verify legal staging',
  )
}

function verifyReleaseAssets() {
  requireMatch(
    '.github/workflows/tauri-build.yml',
    /catgo-legal-bundle\.tar\.gz[\s\S]*gh release upload/,
    'the GitHub release must carry the canonical legal archive',
  )
  requireMatch(
    '.github/workflows/r2-release-mirror.yml',
    /Verify mirrored legal bundle[\s\S]*catgo-legal-bundle\.tar\.gz/,
    'the download mirror must reject a release missing the legal archive',
  )
  requireMatch(
    '.github/workflows/tauri-build.yml',
    /License change in 1\.4\.6[\s\S]*This work used CatGo \(https:\/\/catgo-ucsd\.org\)\.[\s\S]*10\.26434\/chemrxiv\.15002984\/v1[\s\S]*not revoked/i,
    'release body must prominently disclose migration, acknowledgement, DOI, and preserved AGPL grants',
  )
}

function verifySidecarsAndArchives() {
  requireMatch(
    'server/catgo_server.spec',
    /build['"]?\s*\/\s*['"]legal-bundle['"]?[\s\S]*['"]legal['"]/,
    'PyInstaller sidecars must embed the canonical legal bundle',
  )
  requireMatch(
    '.github/workflows/build-vscode-sidecars.yml',
    /node scripts\/sync-legal-bundle\.mjs[\s\S]*Verify embedded legal bundle[\s\S]*pyi-archive_viewer/,
    'VS Code sidecar builds must stage and inspect embedded legal files',
  )
  requireMatch(
    '.github/workflows/build-stt-accel.yml',
    /node scripts\/sync-legal-bundle\.mjs[\s\S]*build\/legal-bundle[\s\S]*dist\/\$\{\{ matrix\.key \}\}\/legal/,
    'STT archives must contain the canonical legal directory',
  )
}

function verifyHpcAndDocker() {
  requireMatch(
    '.github/workflows/hpc-bundle.yml',
    /build\/legal-bundle[\s\S]*\$BUNDLE_DIR\/legal[\s\S]*tar czf[\s\S]*frontend server legal/,
    'HPC tarball must include a top-level legal directory',
  )
  requireMatch(
    'Dockerfile',
    /COPY --from=builder \/app\/build\/legal-bundle \/usr\/share\/doc\/catgo/,
    'Docker runtime image must retain legal files under /usr/share/doc/catgo',
  )
}

function main() {
  verifySources()
  verifyDiscovery()
  verifyBuildEntryPoints()
  verifyTauriAndMobile()
  verifyWebDistributions()
  verifyReleaseAssets()
  verifySidecarsAndArchives()
  verifyHpcAndDocker()

  const report = {
    classes: CLASSES,
    acknowledgement: ACKNOWLEDGEMENT,
    requiredFiles: legalBundleSources().length + 1,
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    process.stdout.write(
      `[legal-verify] ${report.classes.length} distribution classes; ` +
        `${report.requiredFiles} required files\n`,
    )
  }
}

main()
