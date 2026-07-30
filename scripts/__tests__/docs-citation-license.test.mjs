import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const CITATION_REQUEST =
  'If CatGo contributes to your work, please acknowledge and cite it as ' +
  'described below. This request is not an additional condition of ' +
  'AGPL-3.0-or-later.'
const ENGLISH_FOOTER =
  'CatGo is licensed under AGPL-3.0-or-later. If CatGo contributes to your ' +
  'work, please include “This work used CatGo (https://catgo-ucsd.org).” and ' +
  'the preferred citation in CITATION.cff. This request is not an additional ' +
  'condition of the AGPL license.'
const CHINESE_FOOTER =
  'CatGo 采用 AGPL-3.0-or-later。若 CatGo 对你的工作有所帮助，请注明 ' +
  '“This work used CatGo (https://catgo-ucsd.org).”并引用 CITATION.cff ' +
  '中的首选文献；该请求不构成 AGPL 许可的附加条件。'

test('active documentation footers request citation without adding AGPL conditions', () => {
  const config = read('docs/.vitepress/config.ts')
  const footerMessages = [
    ...config.matchAll(/footer:\s*\{\s*message:\s*`([^`]*)`/g),
  ].map((match) => match[1])

  assert.equal(footerMessages.length, 2)
  assert.doesNotMatch(footerMessages.join('\n'),
    /CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial|COMMERCIAL_LICENSE|prior written commercial permission/i)

  const [chinese, english] = footerMessages
  assert.equal(chinese, CHINESE_FOOTER)
  assert.equal(english, ENGLISH_FOOTER)
  for (const message of footerMessages) {
    assert.match(message, new RegExp(escapeRegExp(ACK)))
    assert.match(message, /CITATION\.cff/)
  }
})

test('CITATION.cff carries the exact non-binding citation request', () => {
  const cff = read('CITATION.cff')
  const message = cff.match(/^message:\s*(.+)$/m)?.[1]

  assert.ok(message, 'CITATION.cff must define the CFF 1.2 message field')
  assert.equal(message, CITATION_REQUEST)
  assert.match(cff, new RegExp(
    `^cff-version: 1\\.2\\.0\\nmessage: ${escapeRegExp(CITATION_REQUEST)}\\n` +
    'version: 1\\.4\\.8\\ntitle: CatGo\\nlicense: AGPL-3\\.0-or-later\\n' +
    'license-url: https://github\\.com/Hello-QM/catgo-LRG/blob/main/license$',
    'm',
  ))
  assert.match(cff, /^\s+doi: 10\.26434\/chemrxiv\.15002984\/v1$/m)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
