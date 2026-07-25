import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const DOI = '10.26434/chemrxiv.15002984/v1'
const CUSTOM_LICENSE = 'LicenseRef-CatGo-Noncommercial-1.0'
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
    'COMMERCIAL_LICENSE.md',
    'docs/.vitepress/config.ts',
    'extensions/rust-wasm/README.md',
    'extensions/vscode/readme.md',
    'license',
    'readme.md',
    'readme.zh.md',
    'server/README-pypi.md',
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
    'THIRD_PARTY_NOTICES.md',
    'extensions/rust-wasm/THIRD_PARTY_NOTICES.md',
    'extensions/vscode/THIRD_PARTY_NOTICES.md',
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
    assert.equal(plugin.license, CUSTOM_LICENSE, file)
  }

  const dosProject = section('extensions/dos-analysis/pyproject.toml', 'project')
  assert.match(dosProject, /^license = "LicenseRef-CatGo-Noncommercial-1\.0"$/m)
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

test('root license prohibits unauthorized commercial use', () => {
  const text = read('license')
  assert.match(text, /CatGo Noncommercial Research License 1\.0/)
  assert.match(text, /prior written permission/i)
  assert.match(text, /for-profit entity/i)
  assert.match(text, /terminates automatically/i)
  assert.match(text, /injunctive relief/i)
  assert.match(text, /THIRD_PARTY_NOTICES\.md/)
  assert.match(text, new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
})

test('canonical citation file contains mandatory citation data', () => {
  assert.equal(existsSync(resolve(ROOT, 'citation.cff')), false)
  const text = read('CITATION.cff')
  assert.match(text, /^cff-version: 1\.2\.0$/m)
  assert.match(text, /^version: 1\.4\.6$/m)
  assert.doesNotMatch(text, /^license:/m)
  assert.match(text, /^license-url: https:\/\/github\.com\/Hello-QM\/catgo-LRG\/blob\/main\/license$/m)
  assert.match(text, /CatGo: Bridging CLI Coding Agents/)
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
  assert.match(text, /If you use CatGo, you must acknowledge and cite it/)
})

test('commercial license page repeats the enforceable entry points', () => {
  const text = read('COMMERCIAL_LICENSE.md')
  assert.match(text, /gul026@ucsd\.edu/)
  assert.match(text, /LicenseRef-CatGo-Noncommercial-1\.0/)
  assert.match(text, /not open source/i)
  assert.match(text, /historical releases/i)
})

const customNpm = [
  'package.json',
  'extensions/rust-wasm/package.json',
  'extensions/vscode/package.json',
]
const customCargo = [
  ['crates/catgo-graph/Cargo.toml', '../../license'],
  ['extensions/catrender-wasm/Cargo.toml', '../../license'],
  ['extensions/chgdiff-wasm/Cargo.toml', '../../license'],
  ['extensions/rust/Cargo.toml', '../../license'],
  ['src-tauri/Cargo.toml', '../license'],
  ['src-tauri/plugins/tauri-plugin-bg-grace/Cargo.toml', '../../../license'],
  ['src-tauri/plugins/tauri-plugin-ios-speech/Cargo.toml', '../../../license'],
  ['tools/cube-processor/Cargo.toml', '../../license'],
]

test('first-party manifests resolve to the custom license', () => {
  for (const file of customNpm) {
    assert.equal(JSON.parse(read(file)).license, 'SEE LICENSE IN license', file)
  }
  const pyproject = read('server/pyproject.toml')
  assert.match(pyproject, /^license = "LicenseRef-CatGo-Noncommercial-1\.0"$/m)
  assert.match(pyproject, /^license-files = \["LICENSE"\]$/m)
  for (const [file, relative] of customCargo) {
    const text = read(file)
    assert.match(
      text,
      new RegExp(`^license-file = "${relative.replaceAll('.', '\\.')}"$`, 'm'),
      file,
    )
    assert.doesNotMatch(text, /^license = /m, file)
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
  for (const directory of [
    'extensions/rust-wasm',
    'extensions/vscode',
    'server',
  ]) {
    for (const file of ['CITATION.cff', 'THIRD_PARTY_NOTICES.md']) {
      const local = `${directory}/${file}`
      assert.ok(existsSync(resolve(ROOT, local)), local)
      assert.equal(read(local), read(file), local)
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

test('published npm archive listings contain the redistribution bundle', () => {
  for (const [directory, required] of [
    [
      '.',
      [
        'license',
        'CITATION.cff',
        'THIRD_PARTY_NOTICES.md',
        'readme.md',
        ...thirdPartyLicenseTargets('THIRD_PARTY_NOTICES.md'),
      ],
    ],
    [
      'extensions/rust-wasm',
      [
        'license',
        'CITATION.cff',
        'THIRD_PARTY_NOTICES.md',
        'README.md',
        ...thirdPartyLicenseTargets('extensions/rust-wasm/THIRD_PARTY_NOTICES.md'),
      ],
    ],
  ]) {
    const output = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: resolve(ROOT, directory),
        encoding: 'utf8',
        env: { ...process.env, npm_config_loglevel: 'silent' },
      },
    )
    const paths = JSON.parse(output)[0].files.map(({ path }) => path)
    for (const file of required) assert.ok(paths.includes(file), `${directory}: ${file}`)
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

test('example plugins declare the CatGo custom license', () => {
  for (const file of [
    'examples/plugins/charge-coloring/catgo-plugin.json',
    'examples/plugins/lennard-jones-calculator/catgo-plugin.json',
  ]) {
    assert.equal(
      JSON.parse(read(file)).license,
      'LicenseRef-CatGo-Noncommercial-1.0',
      file,
    )
  }
})

test('separately licensed crates retain their own terms', () => {
  assert.match(read('extensions/uff-relax/Cargo.toml'), /MIT OR Apache-2\.0/)
  assert.match(read('extensions/vsepr-rs/Cargo.toml'), /MIT OR Apache-2\.0/)
})

const userDocs = ['readme.md', 'readme.zh.md', 'server/README-pypi.md']

test('user docs require acknowledgement, citation, and commercial permission', () => {
  for (const file of userDocs) {
    const text = read(file)
    assert.match(text, /CatGo Noncommercial Research License 1\.0/, file)
    assert.match(text, /CITATION\.cff/, file)
    assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')), file)
    assert.match(text, /COMMERCIAL_LICENSE\.md/, file)
    assert.doesNotMatch(text, /AGPL-3\.0-or-later|AGPL v3/, file)
    assert.match(
      text,
      new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      file,
    )
  }
  const englishReadme = read('readme.md')
  assert.match(englishReadme, /must .*citation/i)
  assert.match(englishReadme, /prior written permission/i)
  const pypiReadme = read('server/README-pypi.md')
  assert.match(pypiReadme, /Every such public output must also cite/i)
  assert.match(pypiReadme, /prior written permission/i)
  const chineseReadme = read('readme.zh.md')
  assert.match(chineseReadme, /必须.*致谢.*引用/)
  assert.match(chineseReadme, /必须事先取得书面许可/)
})

test('contribution guides disclose the relicensing authority requirement', () => {
  const english = read('contributing.md')
  assert.match(english, /must have the right to submit/i)
  assert.match(english, /third-party code must retain its original notices/i)
  assert.match(english, /not.*relicense third-party/i)
  assert.match(english, /does not by itself prove copyright assignment/i)
  assert.match(english, /may require a separate\s+contributor agreement/i)
  assert.match(english, /right to license and enforce/i)
  assert.match(english, /must not weaken or contradict.*noncommercial terms/i)

  const chinese = read('contributing.zh.md')
  assert.match(chinese, /贡献者必须有权/)
  assert.match(chinese, /第三方代码必须保留原有声明/)
  assert.match(chinese, /并不会.*重新许可.*第三方代码/)
  assert.match(chinese, /接受.*本身并不证明著作权已经转让/)
  assert.match(chinese, /可在接受贡献前要求单独的贡献者协议/)
  assert.match(chinese, /许可和维权/)
  assert.match(chinese, /不得削弱或抵触.*非商业条款/)
})

test('active first-party surfaces contain no stale AGPL grant', () => {
  const active = new Set([
    ...manifestInventory.publishableFirstParty,
    ...manifestInventory.explicitInternalFirstParty,
    ...licenseClaimInventory.activeFirstParty,
    'server/LICENSE',
    'extensions/rust-wasm/license',
    'extensions/vscode/license',
    'extensions/rust-wasm/CITATION.cff',
    'extensions/vscode/CITATION.cff',
    'server/CITATION.cff',
    'contributing.md',
    'contributing.zh.md',
    'CITATION.cff',
  ])
  for (const file of active) {
    assert.doesNotMatch(read(file), /AGPL|GNU AFFERO/i, file)
  }
  const vscodeReadme = read('extensions/vscode/readme.md')
  assert.match(vscodeReadme, /CatGo Noncommercial Research License 1\.0/)
  assert.match(
    vscodeReadme,
    new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  assert.match(vscodeReadme, /must also cite CatGo/i)
  assert.match(vscodeReadme, new RegExp(DOI.replaceAll('.', '\\.')))
  assert.match(
    vscodeReadme,
    /Commercial use requires\s+prior written permission/i,
  )
  assert.match(vscodeReadme, /gul026@ucsd\.edu/)
})
