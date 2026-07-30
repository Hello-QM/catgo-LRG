import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const APP_VERSION = '1.4.7'
const WORKFLOW_INVENTORY = {
  'android-build.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /inputs\.release_tag/,
      requireSource: /inputs\.release_tag/,
    },
  },
  'build-stt-accel.yml': {
    classification: 'independently-versioned-publisher',
  },
  'build-vscode-sidecars.yml': {
    classification: 'root-versioned-publisher',
    externalGateOwner:
      'excluded from this change because another agent owns this workflow',
  },
  'deploy-cloudflare.yml': {
    classification: 'unversioned-publisher',
  },
  'docker-publish.yml': {
    classification: 'rolling-publisher',
  },
  'finalize-release.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /--tag "\$RELEASE_TAG"/,
      requireSource: /--require-tag/,
      cli: true,
    },
  },
  'hpc-bundle.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /github\.ref_name[\s\S]*inputs\.release_tag/,
      requireSource: /refs\/tags[\s\S]*inputs\.release_tag/,
    },
  },
  'ios-build.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /inputs\.release_tag/,
      requireSource: /inputs\.upload/,
    },
  },
  'lint.yml': {
    classification: 'non-publisher',
  },
  'pypi-publish.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /steps\.request\.outputs\.release_tag/,
      requireSource: /RELEASE_VERSION_REQUIRE_TAG:\s*true/,
    },
  },
  'r2-release-mirror.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Validate release assets against target tag',
      tagSource: /--tag "\$tag"/,
      requireSource: /--require-tag/,
      cli: true,
    },
  },
  'tauri-build.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /github\.ref_name/,
      requireSource: /RELEASE_VERSION_REQUIRE_TAG:.*refs\/tags/,
    },
  },
  'tauri-test-build.yml': {
    classification: 'non-publisher',
  },
  'server-python-tests.yml': {
    classification: 'non-publisher',
  },
  'test.yml': {
    classification: 'non-publisher',
  },
  'vsix-publish.yml': {
    classification: 'root-versioned-publisher',
    gate: {
      step: 'Verify release version',
      tagSource: /github\.ref_name/,
      requireSource: /inputs\.dry_run/,
    },
  },
}
const PUBLISHER_SIGNAL =
  /softprops\/action-gh-release|gh release (?:create|edit|upload)|gh api --method PATCH|tauri-apps\/tauri-action|gh-action-pypi-publish|vsce publish|ovsx publish|docker\/build-push-action|cloudflare\/wrangler-action|pnpm dlx wrangler@\S+ deploy|xcrun altool|aws s3 sync/
const activeWorkflowSource = (path) =>
  source(path)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

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

test('all CatGo application version surfaces target v1.4.7', () => {
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
    APP_VERSION,
  )
})

test('VSIX and citation package metadata target v1.4.7', () => {
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

test('the desktop draft release notes describe v1.4.7', () => {
  const workflow = source('.github/workflows/tauri-build.yml')

  assert.match(workflow, /### New in 1\.4\.7/)
  assert.match(workflow, /Windows desktop app closes normally again/)
  assert.match(workflow, /VS Code structure generation consistently loads compatible WASM/)
  assert.match(workflow, /More reliable multi-platform releases/)
})

test('VSIX publishing fails on duplicate marketplace versions', () => {
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

test('manual HPC publishing uploads to the same release tag required by the gate', () => {
  const uploadStep = workflowStep(
    '.github/workflows/hpc-bundle.yml',
    'Upload to release',
  )
  assert.match(uploadStep, /if:.*inputs\.release_tag != ''/)
  assert.match(
    uploadStep,
    /tag_name:.*github\.ref_name.*inputs\.release_tag/,
  )
})

test('every GitHub workflow has an explicit publisher classification', () => {
  const workflowDirectory = resolve(ROOT, '.github/workflows')
  const actual = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  const classified = Object.keys(WORKFLOW_INVENTORY).sort()
  assert.deepEqual(actual, classified)

  for (const [name, { classification }] of Object.entries(
    WORKFLOW_INVENTORY,
  )) {
    const publishes = PUBLISHER_SIGNAL.test(
      activeWorkflowSource(`.github/workflows/${name}`),
    )
    assert.equal(
      publishes,
      classification !== 'non-publisher',
      `${name}: ${classification}`,
    )
  }
})

test('every root-versioned publisher delegates version policy to the shared verifier', () => {
  for (const [name, integration] of Object.entries(WORKFLOW_INVENTORY)) {
    if (integration.classification !== 'root-versioned-publisher') continue
    if (integration.externalGateOwner) {
      assert.equal(name, 'build-vscode-sidecars.yml')
      assert.match(integration.externalGateOwner, /another agent owns/)
      continue
    }

    assert.ok(integration.gate, `${name} declares its release-version gate`)
    const path = `.github/workflows/${name}`
    const { step: stepName, tagSource, requireSource, cli } = integration.gate
    const step = workflowStep(path, stepName)
    assert.match(step, /node scripts\/verify-release-version\.mjs/, path)
    if (!cli) {
      assert.match(step, /RELEASE_VERSION_TAG:/, path)
      assert.match(step, /RELEASE_VERSION_REQUIRE_TAG:/, path)
    }
    assert.match(step, tagSource, path)
    assert.match(step, requireSource, path)
  }
})

test('the package script and main CI run every Node script test', () => {
  const packageJson = JSON.parse(source('package.json'))
  assert.equal(
    packageJson.scripts['test:node'],
    'pnpm legal:sync && node --test scripts/__tests__/*.test.mjs workers/downloads/index.test.mjs',
  )

  const step = workflowStep('.github/workflows/test.yml', 'Run Node script tests')
  assert.match(step, /pnpm test:node/)
})
