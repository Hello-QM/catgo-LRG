#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArguments(argv) {
  const options = {
    root: REPOSITORY_ROOT,
    tag: process.env.RELEASE_SOURCE_TAG?.trim() || undefined,
    requireTag: /^(?:1|true|yes)$/i.test(
      process.env.RELEASE_SOURCE_REQUIRE_TAG ?? '',
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

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  })
}

function validateTag(root, tag) {
  const ref = `refs/tags/${tag}`
  const result = git(root, ['check-ref-format', ref])
  if (result.status !== 0) {
    throw new Error(`invalid release tag ${JSON.stringify(tag)}`)
  }
  return ref
}

function resolveCommit(root, revision, description) {
  const result = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    revision,
  ])
  const commit = result.stdout.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`cannot resolve ${description}`)
  }
  return commit.toLowerCase()
}

function verifyReleaseSource({ root, tag, requireTag }) {
  if (requireTag && !tag) {
    throw new Error('release tag is required for a publishing workflow')
  }
  if (!tag) return undefined

  const tagRef = validateTag(root, tag)
  const headCommit = resolveCommit(root, 'HEAD^{commit}', 'HEAD commit')
  const tagCommit = resolveCommit(
    root,
    `${tagRef}^{commit}`,
    `release tag ${tag}`,
  )

  if (headCommit !== tagCommit) {
    throw new Error(
      `HEAD commit ${headCommit} does not match release tag ${tag} commit ${tagCommit}`,
    )
  }

  return { tag, commit: headCommit }
}

try {
  const result = verifyReleaseSource(parseArguments(process.argv.slice(2)))
  if (result) {
    console.log(
      `[release-source] HEAD ${result.commit} matches release tag ${result.tag}`,
    )
  } else {
    console.log(
      '[release-source] no release tag requested; build-only source accepted',
    )
  }
} catch (error) {
  console.error(`[release-source] ${error.message}`)
  process.exitCode = 1
}
