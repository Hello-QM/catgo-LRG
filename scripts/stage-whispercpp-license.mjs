#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = resolve(ROOT, 'scripts/whispercpp-source.json')

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !['--source-root', '--output'].includes(argv[index]) ||
      !argv[index + 1]
    ) {
      throw new Error(
        'Usage: stage-whispercpp-license.mjs ' +
          '--source-root <whisper checkout> --output <archive payload>',
      )
    }
    values.set(argv[index], argv[index + 1])
  }
  for (const required of ['--source-root', '--output']) {
    if (!values.has(required)) throw new Error(`Missing argument: ${required}`)
  }
  return {
    sourceRoot: resolve(values.get('--source-root')),
    output: resolve(values.get('--output')),
  }
}

export function stageWhisperLicense({ sourceRoot, output }) {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const upstreamLicense = resolve(sourceRoot, 'LICENSE')
  if (
    !existsSync(upstreamLicense) ||
    lstatSync(upstreamLicense).isSymbolicLink() ||
    !statSync(upstreamLicense).isFile()
  ) {
    throw new Error('whisper.cpp checkout is missing a regular LICENSE file')
  }

  const gitBin = process.env.CATGO_GIT_BIN || 'git'
  const actualRevision = execFileSync(
    gitBin,
    ['-C', sourceRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim()
  assert.equal(
    actualRevision,
    config.revision,
    'whisper.cpp checkout revision does not match pinned source',
  )
  assert.deepEqual(
    readFileSync(upstreamLicense),
    readFileSync(resolve(ROOT, config.license)),
    'whisper.cpp LICENSE does not match pinned canonical text',
  )

  mkdirSync(output, { recursive: true })
  if (lstatSync(output).isSymbolicLink() || !statSync(output).isDirectory()) {
    throw new Error(`Invalid STT payload directory: ${output}`)
  }
  const destination = resolve(output, 'whisper.cpp')
  if (existsSync(destination)) {
    throw new Error(`Refusing existing whisper legal destination: ${destination}`)
  }
  mkdirSync(destination)
  copyFileSync(upstreamLicense, resolve(destination, 'LICENSE'))
  writeFileSync(
    resolve(destination, 'SOURCE.json'),
    `${JSON.stringify(
      {
        repository: config.repository,
        revision: actualRevision,
        license: 'LICENSE',
      },
      null,
      2,
    )}\n`,
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  stageWhisperLicense(options)
  process.stdout.write('[whisper-license] staged exact upstream license\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[whisper-license] ${error.message}\n`)
    process.exitCode = 1
  }
}
