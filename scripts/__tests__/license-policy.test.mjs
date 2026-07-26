import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { legalBundleSources } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const DOI = '10.26434/chemrxiv.15002984/v1'
const AGPL_ID = 'AGPL-3.0-or-later'
const CITATION_REQUEST =
  'If CatGo contributes to your work, please acknowledge and cite it as ' +
  'described below. This request is not an additional condition of ' +
  'AGPL-3.0-or-later.'
const AGPL_SHA256 =
  '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0'
const FORBLAZE_IMPORT_COMMIT = 'dcb8a503245602dae82a4157de6a69ab1d795fe1'

const noticeLinkTargets = (path) =>
  [
    ...new Set(
      [...read(path).matchAll(/\]\(([^):\s]+)\)/g)]
        .map((match) => match[1]),
    ),
  ].toSorted()

const thirdPartyLicenseTargets = (path) =>
  noticeLinkTargets(path).filter((target) =>
    /^third_party\/licenses\/[^/]+\.txt$/.test(target)
  )

const gitFiles = () =>
  execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)

const manifestInventory = {
  publishableFirstParty: [
    'extensions/rust-wasm/package.json',
    'extensions/vscode/package.json',
    'package.json',
    'server/pyproject.toml',
  ],
  explicitInternalFirstParty: [
    'crates/catgo-graph/Cargo.toml',
    'examples/plugins/charge-coloring/catgo-plugin.json',
    'examples/plugins/lennard-jones-calculator/catgo-plugin.json',
    'extensions/catrender-wasm/Cargo.toml',
    'extensions/chgdiff-wasm/Cargo.toml',
    'extensions/dos-analysis/pyproject.toml',
    'extensions/rust/Cargo.toml',
    'src-tauri/Cargo.toml',
    'src-tauri/plugins/tauri-plugin-bg-grace/Cargo.toml',
    'src-tauri/plugins/tauri-plugin-ios-speech/Cargo.toml',
    'tools/cube-processor/Cargo.toml',
    'workers/cors-relay/package.json',
  ],
  separatelyLicensedFirstParty: [
    'extensions/rust/pyproject.toml',
  ],
  separatelyLicensedThirdParty: [
    'extensions/uff-relax/Cargo.toml',
    'extensions/vsepr-rs/Cargo.toml',
  ],
}

const workflowInventory = {
  publishablePackageArchives: [
    '.github/workflows/pypi-publish.yml',
    '.github/workflows/vsix-publish.yml',
  ],
  bundledApplicationOrReleaseAssets: [
    '.github/workflows/android-build.yml',
    '.github/workflows/build-stt-accel.yml',
    '.github/workflows/build-vscode-sidecars.yml',
    '.github/workflows/docker-publish.yml',
    '.github/workflows/finalize-release.yml',
    '.github/workflows/hpc-bundle.yml',
    '.github/workflows/ios-build.yml',
    '.github/workflows/r2-release-mirror.yml',
    '.github/workflows/tauri-build.yml',
  ],
  deploymentOrValidationOnly: [
    '.github/workflows/deploy-cloudflare.yml',
    '.github/workflows/lint.yml',
    '.github/workflows/tauri-test-build.yml',
    '.github/workflows/test.yml',
  ],
}

const licenseClaimInventory = {
  activeFirstParty: [
    'CITATION.cff',
    'COMMERCIAL_LICENSE.md',
    'contributing.md',
    'contributing.zh.md',
    'docs/.vitepress/config.ts',
    'extensions/rust-wasm/README.md',
    'extensions/vscode/readme.md',
    'license',
    'readme.md',
    'readme.zh.md',
    'server/README-pypi.md',
    'THIRD_PARTY_NOTICES.md',
  ],
  historicalGrantPreservation: [
    '.github/release-notes/v1.4.6.md',
    '.github/workflows/tauri-build.yml',
  ],
  historicalOnly: [
    'CHANGELOG.md',
    'docs/reference/changelog.md',
    'docs/zh/reference/changelog.md',
  ],
  redistributedThirdPartyNotices: [
    'extensions/rust-wasm/CITATION.cff',
    'extensions/rust-wasm/THIRD_PARTY_NOTICES.md',
    'extensions/vscode/CITATION.cff',
    'extensions/vscode/THIRD_PARTY_NOTICES.md',
    'server/CITATION.cff',
    'server/THIRD_PARTY_NOTICES.md',
  ],
}

const flattenInventory = (inventory) =>
  Object.values(inventory).flat().toSorted()

const section = (path, name) => {
  const text = read(path)
  const header = `[${name}]`
  const start = text.indexOf(`${header}\n`)
  assert.notEqual(start, -1, `${path} has ${header}`)
  const bodyStart = start + header.length + 1
  const nextSection = text.indexOf('\n[', bodyStart)
  return text.slice(bodyStart, nextSection === -1 ? undefined : nextSection)
}

test('every tracked package manifest has a distribution classification', () => {
  const discovered = gitFiles()
    .filter((path) =>
      /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|catgo-plugin\.json)$/.test(path)
    )
    .toSorted()
  assert.deepEqual(discovered, flattenInventory(manifestInventory))
})

test('every workflow has a release-surface classification', () => {
  const discovered = gitFiles()
    .filter((path) => path.startsWith('.github/workflows/'))
    .toSorted()
  assert.deepEqual(discovered, flattenInventory(workflowInventory))
})

test('every active or historical license claim has a classification', () => {
  const manifests = new Set(flattenInventory(manifestInventory))
  const packagedCopies = new Set([
    'extensions/rust-wasm/license',
    'extensions/vscode/license',
    'server/LICENSE',
  ])
  const discovered = execFileSync(
    'git',
    [
      'grep',
      '-I',
      '-l',
      '-E',
      'AGPL|GNU AFFERO|CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial-1\\.0',
      '--',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim().split('\n').filter((path) =>
    path &&
    !path.startsWith('docs/superpowers/') &&
    !path.startsWith('scripts/') &&
    !manifests.has(path) &&
    !packagedCopies.has(path)
  ).toSorted()
  assert.deepEqual(discovered, flattenInventory(licenseClaimInventory))
})

test('internal first-party manifests cannot be accidentally published', () => {
  const privateNpm = JSON.parse(read('workers/cors-relay/package.json'))
  assert.equal(privateNpm.private, true)

  for (const file of [
    'examples/plugins/charge-coloring/catgo-plugin.json',
    'examples/plugins/lennard-jones-calculator/catgo-plugin.json',
  ]) {
    const plugin = JSON.parse(read(file))
    assert.equal(plugin.publish, false, file)
    assert.equal(plugin.license, AGPL_ID, file)
  }

  const dosProject = section('extensions/dos-analysis/pyproject.toml', 'project')
  assert.match(dosProject, /^license = "AGPL-3\.0-or-later"$/m)
  assert.match(dosProject, /"Private :: Do Not Upload"/)
  const dosDistribution = section(
    'extensions/dos-analysis/pyproject.toml',
    'tool.catgo.distribution',
  )
  assert.match(dosDistribution, /^publish = false$/m)

  for (const file of [
    'crates/catgo-graph/Cargo.toml',
    'extensions/catrender-wasm/Cargo.toml',
    'extensions/chgdiff-wasm/Cargo.toml',
    'extensions/rust/Cargo.toml',
    'src-tauri/Cargo.toml',
    'src-tauri/plugins/tauri-plugin-bg-grace/Cargo.toml',
    'src-tauri/plugins/tauri-plugin-ios-speech/Cargo.toml',
    'tools/cube-processor/Cargo.toml',
  ]) {
    assert.match(section(file, 'package'), /^publish = false$/m, file)
  }
})

test('separately licensed first-party metadata retains its MIT provenance', () => {
  const project = section('extensions/rust/pyproject.toml', 'project')
  assert.match(project, /^license = \{ text = "MIT" \}$/m)
  assert.match(project, /name = "LRG"/)
  assert.match(project, /email = "gul026@ucsd\.edu"/)
  assert.match(read('extensions/rust/pyproject.toml'), /Hello-QM/)
})

test('separately licensed third-party manifests retain semantic license fields', () => {
  for (const file of [
    'extensions/uff-relax/Cargo.toml',
    'extensions/vsepr-rs/Cargo.toml',
  ]) {
    assert.match(section(file, 'package'), /^license = "MIT OR Apache-2\.0"$/m)
  }
})

test('root license is the canonical GNU AGPL v3 text', () => {
  const bytes = readFileSync(resolve(ROOT, 'license'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), AGPL_SHA256)
  assert.match(bytes.toString('utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/)
  assert.doesNotMatch(bytes.toString('utf8'), /CatGo Noncommercial Research License/)
})

test('canonical citation file requests citation without adding an AGPL condition', () => {
  assert.equal(existsSync(resolve(ROOT, 'citation.cff')), false)
  const text = read('CITATION.cff')
  assert.match(text, /^cff-version: 1\.2\.0$/m)
  assert.match(text, /^version: 1\.4\.6$/m)
  assert.match(text, /^license: AGPL-3\.0-or-later$/m)
  assert.match(text, /^license-url: https:\/\/github\.com\/Hello-QM\/catgo-LRG\/blob\/main\/license$/m)
  assert.match(text, /CatGo: Bridging CLI Coding Agents/)
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
  assert.match(text, new RegExp(CITATION_REQUEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('commercial license page is a superseded AGPL notice', () => {
  const text = read('COMMERCIAL_LICENSE.md')
  assert.match(text, /superseded.*AGPL-3\.0-or-later/is)
  assert.doesNotMatch(text, /commercial use requires|prior written commercial permission/i)
})

test('first-party manifests declare AGPL-3.0-or-later', () => {
  for (const file of ['package.json', 'extensions/rust-wasm/package.json',
    'extensions/vscode/package.json']) {
    assert.equal(JSON.parse(read(file)).license, AGPL_ID, file)
  }
  assert.match(read('server/pyproject.toml'), /^license = "AGPL-3\.0-or-later"$/m)
  assert.match(read('extensions/dos-analysis/pyproject.toml'),
    /^license = "AGPL-3\.0-or-later"$/m)
  for (const file of manifestInventory.explicitInternalFirstParty
    .filter((path) => path.endsWith('Cargo.toml'))) {
    assert.match(section(file, 'package'),
      /^license = "AGPL-3\.0-or-later"$/m, file)
  }
})

test('package-local license copies are byte-identical', () => {
  const rootLicense = read('license')
  assert.equal(read('server/LICENSE'), rootLicense)
  assert.equal(read('extensions/rust-wasm/license'), rootLicense)
  assert.equal(read('extensions/vscode/license'), rootLicense)
  const wasmPackage = JSON.parse(read('extensions/rust-wasm/package.json'))
  assert.ok(wasmPackage.files.includes('license'))
})

test('package-local redistribution bundles are byte-identical and acknowledged', () => {
  for (const [directory, licenseName] of [
    ['extensions/rust-wasm', 'license'],
    ['extensions/vscode', 'license'],
    ['server', 'LICENSE'],
  ]) {
    for (const source of legalBundleSources()) {
      const local = `${directory}/${source === 'license' ? licenseName : source}`
      assert.ok(existsSync(resolve(ROOT, local)), local)
      assert.deepEqual(readFileSync(resolve(ROOT, local)), readFileSync(resolve(ROOT, source)), local)
    }
  }
  assert.match(read('extensions/rust-wasm/README.md'), new RegExp(
    ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ))
  assert.match(read('extensions/vscode/readme.md'), new RegExp(
    ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ))
  assert.match(read('server/README-pypi.md'), new RegExp(
    ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ))
})

test('Forblaze UFF and VSEPR notices retain factual source and license evidence', () => {
  const notice = read('THIRD_PARTY_NOTICES.md')
  for (const [component, source] of [
    ['uff-relax', 'https://github.com/ForblazeProject/uff-relax.git'],
    ['vsepr-rs', 'https://github.com/ForblazeProject/vsepr-rs.git'],
  ]) {
    assert.match(notice, new RegExp(source.replace(/[.]/g, '\\.')), component)
    assert.match(notice, new RegExp(component), component)
  }
  assert.match(notice, /Forblaze Project/)
  assert.match(notice, /MIT OR Apache-2\.0/)
  assert.match(notice, new RegExp(FORBLAZE_IMPORT_COMMIT))

  for (const [target, source] of [
    ['third_party/licenses/uff-relax-MIT.txt', 'extensions/uff-relax/LICENSE-MIT'],
    [
      'third_party/licenses/uff-relax-Apache-2.0.txt',
      'extensions/uff-relax/LICENSE-APACHE',
    ],
    ['third_party/licenses/vsepr-rs-MIT.txt', 'extensions/vsepr-rs/LICENSE-MIT'],
    [
      'third_party/licenses/vsepr-rs-Apache-2.0.txt',
      'extensions/vsepr-rs/LICENSE-APACHE',
    ],
  ]) {
    assert.ok(thirdPartyLicenseTargets('THIRD_PARTY_NOTICES.md').includes(target), target)
    assert.equal(read(target), read(source), target)
  }
})

test('every package-local notice resolves its complete byte-identical license bundle', () => {
  const canonicalTargets = thirdPartyLicenseTargets('THIRD_PARTY_NOTICES.md')
  assert.ok(canonicalTargets.length > 0)
  for (const target of canonicalTargets) {
    assert.ok(existsSync(resolve(ROOT, target)), target)
  }

  for (const directory of [
    'extensions/rust-wasm',
    'extensions/vscode',
    'server',
  ]) {
    const localNotice = `${directory}/THIRD_PARTY_NOTICES.md`
    const localTargets = thirdPartyLicenseTargets(localNotice)
    assert.deepEqual(localTargets, canonicalTargets, localNotice)
    for (const target of localTargets) {
      const local = `${directory}/${target}`
      assert.ok(existsSync(resolve(ROOT, local)), local)
      assert.equal(read(local), read(target), local)
    }
  }

  for (const [directory, notice] of [
    ['.', 'THIRD_PARTY_NOTICES.md'],
    ['extensions/rust-wasm', 'extensions/rust-wasm/THIRD_PARTY_NOTICES.md'],
    ['extensions/vscode', 'extensions/vscode/THIRD_PARTY_NOTICES.md'],
    ['server', 'server/THIRD_PARTY_NOTICES.md'],
  ]) {
    for (const target of noticeLinkTargets(notice)) {
      assert.ok(
        existsSync(resolve(ROOT, directory, target)),
        `${notice}: ${target}`,
      )
    }
  }
})

test('actual npm archives contain exactly the canonical redistribution sources', () => {
  const archiveDir = mkdtempSync(resolve(tmpdir(), 'catgo-npm-legal-'))
  const expected = legalBundleSources().toSorted()
  try {
    for (const directory of ['.', 'extensions/rust-wasm']) {
      const output = execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', archiveDir],
        {
          cwd: resolve(ROOT, directory),
          encoding: 'utf8',
          env: { ...process.env, npm_config_loglevel: 'silent' },
        },
      )
      const archive = resolve(archiveDir, JSON.parse(output)[0].filename)
      const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((path) => path.replace(/^package\//, ''))
      const packagedLegal = paths
        .filter((path) =>
          ['license', 'CITATION.cff', 'THIRD_PARTY_NOTICES.md'].includes(path) ||
          path.startsWith('third_party/licenses/') ||
          path.startsWith('third_party/provenance/'),
        )
        .toSorted()

      assert.deepEqual(packagedLegal, expected, directory)
    }
  } finally {
    rmSync(archiveDir, { recursive: true, force: true })
  }
})

test('actual wheel and sdist contain exactly the canonical redistribution sources', () => {
  const archiveDir = mkdtempSync(resolve(tmpdir(), 'catgo-python-legal-'))
  const expected = legalBundleSources().toSorted()
  const selectLegal = (paths) =>
    paths
      .filter((path) =>
        ['license', 'CITATION.cff', 'THIRD_PARTY_NOTICES.md'].includes(path) ||
        path.startsWith('third_party/licenses/') ||
        path.startsWith('third_party/provenance/'),
      )
      .toSorted()

  try {
    execFileSync(
      'uv',
      ['build', '--wheel', '--sdist', '--out-dir', archiveDir],
      { cwd: resolve(ROOT, 'server'), stdio: 'pipe' },
    )
    const archives = readdirSync(archiveDir)
    const wheel = resolve(archiveDir, archives.find((name) => name.endsWith('.whl')))
    const sdist = resolve(archiveDir, archives.find((name) => name.endsWith('.tar.gz')))

    const wheelPaths = execFileSync('unzip', ['-Z1', wheel], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((path) => {
        if (/^[^/]+\.dist-info\/licenses\/LICENSE$/.test(path)) return 'license'
        return path.replace(/^catgo\//, '')
      })
    assert.deepEqual(selectLegal(wheelPaths), expected, 'wheel')

    const sdistPaths = execFileSync('tar', ['-tzf', sdist], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((path) => path.replace(/^[^/]+\//, ''))
      .map((path) => path === 'LICENSE' ? 'license' : path)
    assert.deepEqual(selectLegal(sdistPaths), expected, 'sdist')
  } finally {
    rmSync(archiveDir, { recursive: true, force: true })
  }
})

test('actual VSIX contains exactly the canonical redistribution sources', () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'catgo-vsix-legal-'))
  const extensionRoot = resolve(fixtureRoot, 'extension')
  const archive = resolve(fixtureRoot, 'catgo.vsix')
  try {
    mkdirSync(extensionRoot)
    for (const path of [
      '.vscodeignore',
      'CITATION.cff',
      'THIRD_PARTY_NOTICES.md',
      'icon.png',
      'license',
      'package.json',
      'readme.md',
      'third_party',
    ]) {
      cpSync(
        resolve(ROOT, 'extensions/vscode', path),
        resolve(extensionRoot, path),
        { recursive: true },
      )
    }
    mkdirSync(resolve(extensionRoot, 'dist'))
    writeFileSync(resolve(extensionRoot, 'dist/extension.cjs'), 'module.exports = {}\n')

    execFileSync(
      resolve(ROOT, 'node_modules/.bin/vsce'),
      ['package', '--no-dependencies', '--out', archive],
      { cwd: extensionRoot, stdio: 'pipe' },
    )
    const packagedLegal = execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((path) => path.replace(/^extension\//, ''))
      .map((path) => path === 'license.txt' ? 'license' : path)
      .filter((path) =>
        ['license', 'CITATION.cff', 'THIRD_PARTY_NOTICES.md'].includes(path) ||
        path.startsWith('third_party/licenses/') ||
        path.startsWith('third_party/provenance/'),
      )
      .toSorted()

    assert.deepEqual(packagedLegal, legalBundleSources().toSorted())
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('Python wheel configuration force-includes the redistribution bundle', () => {
  const wheel = section('server/pyproject.toml', 'tool.hatch.build.targets.wheel.force-include')
  assert.match(wheel, /^"README-pypi\.md" = "catgo\/README\.md"$/m)
  assert.match(wheel, /^"CITATION\.cff" = "catgo\/CITATION\.cff"$/m)
  assert.match(
    wheel,
    /^"THIRD_PARTY_NOTICES\.md" = "catgo\/THIRD_PARTY_NOTICES\.md"$/m,
  )
  assert.match(
    wheel,
    /^"third_party\/licenses" = "catgo\/third_party\/licenses"$/m,
  )
})

test('example plugins declare AGPL-3.0-or-later', () => {
  for (const file of [
    'examples/plugins/charge-coloring/catgo-plugin.json',
    'examples/plugins/lennard-jones-calculator/catgo-plugin.json',
  ]) {
    assert.equal(
      JSON.parse(read(file)).license,
      AGPL_ID,
      file,
    )
  }
})

test('separately licensed crates retain their own terms', () => {
  assert.match(read('extensions/uff-relax/Cargo.toml'), /MIT OR Apache-2\.0/)
  assert.match(read('extensions/vsepr-rs/Cargo.toml'), /MIT OR Apache-2\.0/)
})

const userDocs = [
  'readme.md',
  'readme.zh.md',
  'server/README-pypi.md',
  'extensions/rust-wasm/README.md',
  'extensions/vscode/readme.md',
  'docs/.vitepress/config.ts',
  'contributing.md',
  'contributing.zh.md',
]

test('active user surfaces make citation a non-binding AGPL request', () => {
  for (const file of userDocs) {
    const text = read(file)
    assert.doesNotMatch(text,
      /CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial|COMMERCIAL_LICENSE|prior written commercial permission/i, file)
    assert.match(text, /AGPL-3\.0-or-later/, file)
    assert.match(text, /not an additional condition|不构成.*附加条件/i, file)
  }
})

test('contribution guides preserve third-party provenance under AGPL', () => {
  const english = read('contributing.md')
  assert.match(english, /must have the right to submit/i)
  assert.match(english, /third-party code must retain its original notices/i)
  assert.match(english, /not.*relicense third-party/i)
  assert.match(english, /does not by itself prove copyright assignment/i)
  assert.match(english, /AGPL-3\.0-or-later/)
  assert.match(english, /not an additional condition/i)

  const chinese = read('contributing.zh.md')
  assert.match(chinese, /贡献者必须有权/)
  assert.match(chinese, /第三方代码必须保留原有声明/)
  assert.match(chinese, /并不会.*重新许可.*第三方代码/)
  assert.match(chinese, /接受.*本身并不证明著作权已经转让/)
  assert.match(chinese, /AGPL-3\.0-or-later/)
  assert.match(chinese, /不构成.*附加条件/)
})

test('active non-package surfaces declare AGPL without custom licensing claims', () => {
  const active = new Set([
    ...licenseClaimInventory.activeFirstParty.filter((file) => file !== 'license'),
    'extensions/rust-wasm/CITATION.cff',
    'extensions/vscode/CITATION.cff',
    'server/CITATION.cff',
    'contributing.md',
    'contributing.zh.md',
    'CITATION.cff',
  ])
  for (const file of active) {
    assert.match(read(file), /AGPL-3\.0-or-later/, file)
    assert.doesNotMatch(read(file),
      /CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial|COMMERCIAL_LICENSE|prior written commercial permission/i, file)
  }
})
