#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CFF_FILES = [
  'CITATION.cff',
  'server/CITATION.cff',
  'extensions/vscode/CITATION.cff',
  'extensions/rust-wasm/CITATION.cff',
]

function parseArguments(argv) {
  const options = {
    root: REPOSITORY_ROOT,
    tag: process.env.RELEASE_VERSION_TAG?.trim() || undefined,
    requireTag: /^(?:1|true|yes)$/i.test(
      process.env.RELEASE_VERSION_REQUIRE_TAG ?? '',
    ),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') {
      if (!argv[index + 1]) throw new Error('--root requires a path')
      options.root = resolve(argv[++index])
    } else if (argument === '--tag') {
      if (!argv[index + 1]) throw new Error('--tag requires a value')
      options.tag = argv[++index]
    } else if (argument === '--require-tag') {
      options.requireTag = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }

  return options
}

function source(root, path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch (error) {
    throw new Error(`${path}: ${error.message}`)
  }
}

function jsonVersion(root, path) {
  try {
    const version = JSON.parse(source(root, path)).version
    if (typeof version !== 'string' || !version) {
      throw new Error('missing string version')
    }
    return version
  } catch (error) {
    throw new Error(`${path}: ${error.message}`)
  }
}

function tomlSectionVersion(root, path, section) {
  const match = new RegExp(
    `^\\[${section.replaceAll('.', '\\\\.')}\\][\\s\\S]*?^version\\s*=\\s*"([^"]+)"`,
    'm',
  ).exec(source(root, path))
  if (!match) throw new Error(`${path}: missing version in [${section}]`)
  return match[1]
}

function cargoLockVersion(root) {
  const path = 'src-tauri/Cargo.lock'
  const match =
    /^\[\[package\]\]\r?\nname = "catgo"\r?\nversion = "([^"]+)"\r?$/m.exec(
      source(root, path),
    )
  if (!match) throw new Error(`${path}: missing catgo package version`)
  return match[1]
}

function cffVersion(root, path) {
  const match = /^version:\s*(\S+)$/m.exec(source(root, path))
  if (!match) throw new Error(`${path}: missing top-level version`)
  return match[1]
}

function verifyReleaseVersion({ root, tag, requireTag }) {
  const version = jsonVersion(root, 'package.json')
  const surfaces = [
    ['src-tauri/tauri.conf.json', jsonVersion(root, 'src-tauri/tauri.conf.json')],
    [
      'src-tauri/Cargo.toml',
      tomlSectionVersion(root, 'src-tauri/Cargo.toml', 'package'),
    ],
    ['src-tauri/Cargo.lock', cargoLockVersion(root)],
    [
      'server/pyproject.toml',
      tomlSectionVersion(root, 'server/pyproject.toml', 'project'),
    ],
    [
      'extensions/vscode/package.json',
      jsonVersion(root, 'extensions/vscode/package.json'),
    ],
    ...CFF_FILES.map((path) => [path, cffVersion(root, path)]),
  ]

  for (const [path, actual] of surfaces) {
    if (actual !== version) {
      throw new Error(
        `${path}: version ${actual} does not match package.json version ${version}`,
      )
    }
  }

  if (requireTag && !tag) {
    throw new Error('release tag is required for a publishing workflow')
  }
  if (tag && tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match; expected v${version}`)
  }

  return { version, tag }
}

try {
  const result = verifyReleaseVersion(parseArguments(process.argv.slice(2)))
  const suffix = result.tag ? ` for ${result.tag}` : ''
  console.log(
    `[release-version] release version ${result.version} verified${suffix}`,
  )
} catch (error) {
  console.error(`[release-version] ${error.message}`)
  process.exitCode = 1
}
