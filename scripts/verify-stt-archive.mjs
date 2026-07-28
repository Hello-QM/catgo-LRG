#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !['--archive', '--legal-root'].includes(argv[index]) ||
      !argv[index + 1]
    ) {
      throw new Error(
        'Usage: verify-stt-archive.mjs ' +
          '--archive <tar.gz|zip> --legal-root <canonical directory>',
      )
    }
    values.set(argv[index], argv[index + 1])
  }
  for (const required of ['--archive', '--legal-root']) {
    if (!values.has(required)) throw new Error(`Missing argument: ${required}`)
  }
  return {
    archive: resolve(values.get('--archive')),
    legalRoot: resolve(values.get('--legal-root')),
  }
}

function inventory(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const rel = relative(root, path)
      if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`Archive inventory escaped root: ${path}`)
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Archive contains a symlink: ${rel}`)
      }
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(rel)
      else throw new Error(`Archive contains unsupported entry: ${rel}`)
    }
  }
  visit(root)
  return files.sort()
}

function listArchive(archive) {
  const zip = archive.endsWith('.zip')
  const command = zip ? 'unzip' : 'tar'
  const args = zip ? ['-Z1', archive] : ['tzf', archive]
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Cannot list STT archive: ${result.stderr || result.stdout}`)
  }
  const entries = result.stdout.split('\n').filter(Boolean)
  for (const raw of entries) {
    const path = raw.replace(/^\.\/+/, '')
    if (
      raw.startsWith('/') ||
      raw.includes('\\') ||
      path.split('/').some((part) => part === '..')
    ) {
      throw new Error(`Unsafe path in STT archive: ${raw}`)
    }
  }
  return { zip, entries }
}

function compareTrees(expected, actual, label) {
  const expectedFiles = inventory(expected)
  const actualFiles = inventory(actual)
  assert.deepEqual(actualFiles, expectedFiles, `${label} file manifest mismatch`)
  for (const path of expectedFiles) {
    assert.deepEqual(
      readFileSync(resolve(actual, path)),
      readFileSync(resolve(expected, path)),
      `${label} content mismatch: ${path}`,
    )
  }
}

export function verifySttArchive({ archive, legalRoot }) {
  if (!existsSync(archive) || lstatSync(archive).isSymbolicLink()) {
    throw new Error(`STT archive does not exist or is a symlink: ${archive}`)
  }
  const { zip, entries } = listArchive(archive)
  if (
    !entries.some((path) =>
      /(?:^|\/)whisper-cli(?:\.exe)?$/.test(path.replace(/^\.\/+/, '')),
    )
  ) {
    throw new Error('STT archive is missing whisper-cli')
  }

  const temporary = mkdtempSync(resolve(tmpdir(), 'catgo-stt-archive-'))
  const extracted = resolve(temporary, 'extracted')
  mkdirSync(extracted)
  try {
    const command = zip ? 'unzip' : 'tar'
    const args = zip
      ? ['-q', archive, '-d', extracted]
      : ['xzf', archive, '-C', extracted]
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`Cannot extract STT archive: ${result.stderr || result.stdout}`)
    }

    compareTrees(legalRoot, resolve(extracted, 'legal'), 'CatGo legal bundle')
    const config = JSON.parse(
      readFileSync(resolve(ROOT, 'scripts/whispercpp-source.json'), 'utf8'),
    )
    assert.deepEqual(
      readFileSync(resolve(extracted, 'whisper.cpp/LICENSE')),
      readFileSync(resolve(ROOT, config.license)),
      'whisper.cpp upstream LICENSE mismatch',
    )
    assert.deepEqual(
      JSON.parse(
        readFileSync(resolve(extracted, 'whisper.cpp/SOURCE.json'), 'utf8'),
      ),
      {
        repository: config.repository,
        revision: config.revision,
        license: 'LICENSE',
      },
      'whisper.cpp source metadata mismatch',
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  verifySttArchive(options)
  process.stdout.write('[stt-archive] exact CatGo and whisper legal material verified\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[stt-archive] ${error.message}\n`)
    process.exitCode = 1
  }
}
