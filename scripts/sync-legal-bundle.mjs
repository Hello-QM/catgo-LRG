#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ACKNOWLEDGEMENT =
  'This work used CatGo (https://catgo-ucsd.org).'

export const DEFAULT_TARGETS = [
  'build/legal-bundle',
  'static/legal',
  'docs/public/legal',
  'src-tauri/resources/legal',
]

const CORE_SOURCES = [
  'license',
  'CITATION.cff',
  'THIRD_PARTY_NOTICES.md',
]

function noticeLicenseSources() {
  const notices = readFileSync(resolve(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const links = [...notices.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter(
      (path) =>
        path.startsWith('third_party/licenses/') ||
        path.endsWith('/LICENSE'),
    )
  return [...new Set(links)].sort()
}

export function legalBundleSources() {
  return [...CORE_SOURCES, ...noticeLicenseSources()]
}

function assertSafeTarget(target) {
  const absolute = resolve(target)
  const root = parse(absolute).root
  if (absolute === root || absolute === ROOT) {
    throw new Error(`Refusing unsafe legal-bundle target: ${absolute}`)
  }
  return absolute
}

export function syncLegalBundle(target) {
  const destination = assertSafeTarget(target)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  for (const source of legalBundleSources()) {
    const sourcePath = resolve(ROOT, source)
    const destinationPath = resolve(destination, source)
    mkdirSync(dirname(destinationPath), { recursive: true })
    copyFileSync(sourcePath, destinationPath)
  }

  writeFileSync(
    resolve(destination, 'ACKNOWLEDGEMENT.txt'),
    `${ACKNOWLEDGEMENT}\n`,
  )
  return destination
}

function parseOutputs(argv) {
  const outputs = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--output' || !argv[index + 1]) {
      throw new Error(`Usage: sync-legal-bundle.mjs [--output <directory>]`)
    }
    outputs.push(argv[index + 1])
    index += 1
  }
  return outputs
}

function main() {
  const requested = parseOutputs(process.argv.slice(2))
  const targets = requested.length
    ? requested.map((target) =>
        isAbsolute(target) ? target : resolve(ROOT, target),
      )
    : DEFAULT_TARGETS.map((target) => resolve(ROOT, target))

  for (const target of targets) {
    const staged = syncLegalBundle(target)
    process.stdout.write(
      `[legal-sync] ${relative(ROOT, staged) || staged}\n`,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
