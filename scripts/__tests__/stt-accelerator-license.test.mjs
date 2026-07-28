import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { syncLegalBundle } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG_PATH = resolve(ROOT, 'scripts/whispercpp-source.json')
const LICENSE_PATH = resolve(
  ROOT,
  'third_party/licenses/whisper.cpp-MIT.txt',
)
const REVISION = '080bbbe85230f624f0b52127f1ae1218247989f9'

function runStage(sourceRoot, output, revision = REVISION) {
  const fakeGit = resolve(dirname(output), 'git')
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${FAKE_GIT_REVISION}"
`,
  )
  chmodSync(fakeGit, 0o755)
  return spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'scripts/stage-whispercpp-license.mjs'),
      '--source-root',
      sourceRoot,
      '--output',
      output,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CATGO_GIT_BIN: fakeGit,
        FAKE_GIT_REVISION: revision,
      },
    },
  )
}

function runArchiveVerifier(archive, legalRoot) {
  return spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'scripts/verify-stt-archive.mjs'),
      '--archive',
      archive,
      '--legal-root',
      legalRoot,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('whisper.cpp source metadata pins one exact upstream revision and license', () => {
  assert.ok(existsSync(CONFIG_PATH), 'whisper source metadata exists')
  assert.ok(existsSync(LICENSE_PATH), 'canonical whisper MIT license exists')
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assert.deepEqual(config, {
    repository: 'https://github.com/ggml-org/whisper.cpp',
    revision: REVISION,
    license: 'third_party/licenses/whisper.cpp-MIT.txt',
  })
  const license = readFileSync(LICENSE_PATH, 'utf8')
  assert.match(license, /^MIT License$/m)
  assert.match(license, /Copyright \(c\) 2023-2026 The ggml authors/)
  assert.match(license, /Permission is hereby granted, free of charge/)
})

test('staging preserves exact upstream license and source revision', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-whisper-stage-'))
  const sourceRoot = resolve(fixture, 'upstream')
  const output = resolve(fixture, 'dist')
  mkdirSync(sourceRoot)
  mkdirSync(output)
  writeFileSync(resolve(sourceRoot, 'LICENSE'), readFileSync(LICENSE_PATH))
  try {
    const result = runStage(sourceRoot, output)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(
      readFileSync(resolve(output, 'whisper.cpp/LICENSE')),
      readFileSync(LICENSE_PATH),
    )
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(output, 'whisper.cpp/SOURCE.json'))),
      {
        repository: 'https://github.com/ggml-org/whisper.cpp',
        revision: REVISION,
        license: 'LICENSE',
      },
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('staging rejects a checkout whose license differs from the pinned source', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-whisper-wrong-'))
  const sourceRoot = resolve(fixture, 'upstream')
  const output = resolve(fixture, 'dist')
  mkdirSync(sourceRoot)
  mkdirSync(output)
  writeFileSync(resolve(sourceRoot, 'LICENSE'), 'different license\n')
  try {
    const result = runStage(sourceRoot, output)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /license.*match|mismatch/i)
    assert.equal(existsSync(resolve(output, 'whisper.cpp')), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Unix accelerator build stages binaries from the pinned checkout with its license', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-whisper-build-'))
  const bin = resolve(fixture, 'bin')
  const output = resolve(fixture, 'payload')
  mkdirSync(bin)
  writeFileSync(
    resolve(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  target="\${@: -1}"
  mkdir -p "$target"
  cp "$FAKE_WHISPER_LICENSE" "$target/LICENSE"
elif [[ "$*" == *"rev-parse HEAD"* ]]; then
  printf '%s\\n' "$FAKE_GIT_REVISION"
fi
`,
  )
  writeFileSync(
    resolve(bin, 'cmake'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-B" ]; then
  mkdir -p build/bin
  printf 'binary\\n' > build/bin/whisper-cli
  chmod +x build/bin/whisper-cli
fi
`,
  )
  chmodSync(resolve(bin, 'git'), 0o755)
  chmodSync(resolve(bin, 'cmake'), 0o755)
  try {
    const result = spawnSync(
      'bash',
      [resolve(ROOT, 'scripts/build-whispercpp.sh'), 'vulkan', output],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_GIT_REVISION: REVISION,
          FAKE_WHISPER_LICENSE: LICENSE_PATH,
        },
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(readFileSync(resolve(output, 'whisper-cli'), 'utf8'), 'binary\n')
    assert.deepEqual(
      readFileSync(resolve(output, 'whisper.cpp/LICENSE')),
      readFileSync(LICENSE_PATH),
    )
    assert.equal(
      JSON.parse(readFileSync(resolve(output, 'whisper.cpp/SOURCE.json'))).revision,
      REVISION,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('actual tar.gz and zip accelerator archives retain exact legal material', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'catgo-whisper-archives-'))
  const sourceRoot = resolve(fixture, 'upstream')
  const payload = resolve(fixture, 'payload')
  mkdirSync(sourceRoot)
  mkdirSync(payload)
  writeFileSync(resolve(sourceRoot, 'LICENSE'), readFileSync(LICENSE_PATH))
  writeFileSync(resolve(payload, 'whisper-cli'), 'binary\n')
  try {
    const staged = runStage(sourceRoot, payload)
    assert.equal(staged.status, 0, staged.stderr || staged.stdout)
    const legalRoot = resolve(payload, 'legal')
    syncLegalBundle(legalRoot)

    const tarPath = resolve(fixture, 'whisper.tar.gz')
    const zipPath = resolve(fixture, 'whisper.zip')
    const tar = spawnSync('tar', ['czf', tarPath, '-C', payload, '.'], {
      encoding: 'utf8',
    })
    assert.equal(tar.status, 0, tar.stderr || tar.stdout)
    const zip = spawnSync('zip', ['-qr', zipPath, '.'], {
      cwd: payload,
      encoding: 'utf8',
    })
    assert.equal(zip.status, 0, zip.stderr || zip.stdout)

    for (const archive of [tarPath, zipPath]) {
      const result = runArchiveVerifier(archive, legalRoot)
      assert.equal(result.status, 0, result.stderr || result.stdout)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
