import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const DOI = '10.26434/chemrxiv.15002984/v1'

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
  assert.match(read('extensions/rust/pyproject.toml'), /MIT/)
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
  const active = [
    'license',
    'package.json',
    'server/LICENSE',
    'server/pyproject.toml',
    'extensions/rust-wasm/license',
    'extensions/rust-wasm/package.json',
    'extensions/vscode/license',
    'extensions/vscode/package.json',
    'extensions/vscode/readme.md',
    'crates/catgo-graph/Cargo.toml',
    'extensions/catrender-wasm/Cargo.toml',
    'extensions/chgdiff-wasm/Cargo.toml',
    'extensions/rust/Cargo.toml',
    'src-tauri/Cargo.toml',
    'tools/cube-processor/Cargo.toml',
    'examples/plugins/charge-coloring/catgo-plugin.json',
    'examples/plugins/lennard-jones-calculator/catgo-plugin.json',
    'readme.md',
    'readme.zh.md',
    'server/README-pypi.md',
    'contributing.md',
    'contributing.zh.md',
    'CITATION.cff',
    'COMMERCIAL_LICENSE.md',
  ]
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
