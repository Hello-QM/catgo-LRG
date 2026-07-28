#!/usr/bin/env node
/**
 * Verify the dual ferrox WASM artifacts (design §8.3, fast-bond-backends).
 *
 * `pnpm build:wasm` must produce BOTH ferrox variants:
 *
 *   extensions/rust-wasm/pkg-scalar/    portable-SIMD, single-thread
 *   extensions/rust-wasm/pkg-threaded/  WASM threads + SIMD + Rayon
 *                                       (wasm-bindgen-rayon thread pool)
 *
 * plus the legacy `pkg/` bridge (a copy of pkg-scalar/ so existing
 * `@catgo/ferrox-wasm` imports keep resolving).
 *
 * Assertions:
 *   - each artifact dir has the full JS/WASM/d.ts set
 *   - the threaded JS glue exports `initThreadPool` (wasm-bindgen-rayon)
 *   - the scalar JS glue does NOT export `initThreadPool` — a scalar build
 *     that exports it means Rayon leaked into the scalar feature set, which
 *     would deadlock without a thread pool. Fail loudly (§8.3).
 *   - the threaded wasm binary IMPORTS a SHARED memory (and the scalar one
 *     does not). rustc can silently drop to a non-shared exported memory if
 *     the --shared-memory/--import-memory link args go missing — the module
 *     still builds and still exports initThreadPool, but its workers can
 *     never share state. This catches that class of regression.
 *   - every file in the legacy pkg/ bridge is byte-identical to pkg-scalar/.
 *
 * Exit code 0 = all good; 1 = one or more assertions failed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WASM_ROOT = join(ROOT, 'extensions', 'rust-wasm')

const ARTIFACT_FILES = ['ferrox.js', 'ferrox_bg.wasm', 'ferrox.d.ts']
const THREAD_POOL_EXPORT = /\binitThreadPool\b/

const failures = []
const ok = (msg) => console.log(`[verify-wasm]   ok: ${msg}`)
const fail = (msg) => {
  failures.push(msg)
  console.error(`[verify-wasm] FAIL: ${msg}`)
}

/** Assert the JS/WASM/d.ts set exists; return the glue JS text (or null). */
function checkArtifactSet(dir) {
  const rel = relative(ROOT, dir)
  let complete = true
  for (const file of ARTIFACT_FILES) {
    const path = join(dir, file)
    if (existsSync(path)) {
      ok(`${rel}/${file} exists`)
    } else {
      fail(`${rel}/${file} missing — run \`pnpm build:wasm\``)
      complete = false
    }
  }
  const glue = join(dir, 'ferrox.js')
  return complete || existsSync(glue) ? readMaybe(glue) : null
}

function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function listRelativeFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(join(dir, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }
  return files.sort()
}

/**
 * Does the wasm binary import a SHARED memory? Minimal binary-format walk:
 * sections are (id: u8, size: LEB); import-section (id 2) entries are
 * (module: name, field: name, kind: u8) where kind 0x02 = memory followed by
 * limits whose flags byte has bit 1 (0x02) set iff the memory is shared.
 * Returns true/false, or null when the file is missing/unparsable.
 */
function importsSharedMemory(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch {
    return null
  }
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) return null
  let pos = 8
  const leb = () => {
    let result = 0, shift = 0, byte
    do {
      byte = buf[pos++]
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return result >>> 0
  }
  while (pos < buf.length) {
    const id = buf[pos++]
    const size = leb()
    const end = pos + size
    if (id !== 2) {
      pos = end
      continue
    }
    const count = leb()
    for (let i = 0; i < count; i++) {
      // NOTE: not `pos += leb()` — JS evaluates the old `pos` before leb()
      // advances it, which would discard the LEB's own bytes.
      const modLen = leb()
      pos += modLen // module name bytes
      const fieldLen = leb()
      pos += fieldLen // field name bytes
      const kind = buf[pos++]
      if (kind === 0x00) {
        leb() // func: type index
      } else if (kind === 0x01) {
        leb() // table: elem type (single byte read as LEB is fine)
        const flags = leb()
        leb()
        if (flags & 0x01) leb()
      } else if (kind === 0x02) {
        const flags = leb()
        if (flags & 0x02) return true // shared bit
        leb()
        if (flags & 0x01) leb()
      } else if (kind === 0x03) {
        pos++ // global: value type
        pos++ // mutability
      } else {
        return null // unknown kind — bail rather than misparse
      }
    }
    return false // parsed the whole import section, no shared memory
  }
  return false // no import section at all
}

// --- 1. Both artifact sets exist (JS glue + wasm binary + TS types) --------
const scalarGlue = checkArtifactSet(join(WASM_ROOT, 'pkg-scalar'))
const threadedGlue = checkArtifactSet(join(WASM_ROOT, 'pkg-threaded'))

// --- 2. Threaded glue exports initThreadPool (wasm-bindgen-rayon) ----------
if (threadedGlue !== null) {
  if (THREAD_POOL_EXPORT.test(threadedGlue)) {
    ok('pkg-threaded/ferrox.js exports initThreadPool')
  } else {
    fail(
      'pkg-threaded/ferrox.js does not export initThreadPool — the threaded ' +
        'build must include wasm-bindgen-rayon (feature wasm-threaded); Rayon ' +
        'without a thread pool deadlocks',
    )
  }
}

// --- 3. Scalar glue must NOT export initThreadPool -------------------------
if (scalarGlue !== null) {
  if (THREAD_POOL_EXPORT.test(scalarGlue)) {
    fail(
      'pkg-scalar/ferrox.js exports initThreadPool — Rayon leaked into the ' +
        'scalar feature set (must be built with --features wasm-scalar ' +
        '--no-default-features)',
    )
  } else {
    ok('pkg-scalar/ferrox.js has no initThreadPool (single-thread build)')
  }
}

// --- 4. Threaded wasm imports a SHARED memory; scalar must not -------------
const threadedShared = importsSharedMemory(join(WASM_ROOT, 'pkg-threaded', 'ferrox_bg.wasm'))
if (threadedShared === true) {
  ok('pkg-threaded/ferrox_bg.wasm imports a shared memory (threads-capable)')
} else if (threadedShared === false) {
  fail(
    'pkg-threaded/ferrox_bg.wasm does NOT import a shared memory — the ' +
      '--shared-memory/--import-memory link args were dropped (rustc emits a ' +
      'non-shared module silently); workers could never share state',
  )
} else if (existsSync(join(WASM_ROOT, 'pkg-threaded', 'ferrox_bg.wasm'))) {
  fail('pkg-threaded/ferrox_bg.wasm could not be parsed as a wasm module')
}

const scalarShared = importsSharedMemory(join(WASM_ROOT, 'pkg-scalar', 'ferrox_bg.wasm'))
if (scalarShared === false) {
  ok('pkg-scalar/ferrox_bg.wasm has no shared-memory import (single-thread build)')
} else if (scalarShared === true) {
  fail('pkg-scalar/ferrox_bg.wasm imports a shared memory — threaded flags leaked into the scalar build')
} else if (existsSync(join(WASM_ROOT, 'pkg-scalar', 'ferrox_bg.wasm'))) {
  fail('pkg-scalar/ferrox_bg.wasm could not be parsed as a wasm module')
}

// --- 5. Legacy pkg/ bridge is an exact copy of pkg-scalar/ -----------------
const scalarDir = join(WASM_ROOT, 'pkg-scalar')
const bridgeDir = join(WASM_ROOT, 'pkg')
if (!existsSync(bridgeDir)) {
  fail('pkg/ bridge missing — build-wasm.mjs should copy pkg-scalar/ → pkg/')
} else if (!existsSync(scalarDir)) {
  fail('pkg-scalar/ missing — cannot verify the legacy pkg/ bridge')
} else {
  const scalarFiles = listRelativeFiles(scalarDir)
  const bridgeFiles = listRelativeFiles(bridgeDir)
  const scalarSet = new Set(scalarFiles)
  const bridgeSet = new Set(bridgeFiles)
  const missing = scalarFiles.filter((file) => !bridgeSet.has(file))
  const extra = bridgeFiles.filter((file) => !scalarSet.has(file))
  const common = scalarFiles.filter((file) => bridgeSet.has(file))
  const mismatches = common.filter((file) =>
    !readFileSync(join(scalarDir, file)).equals(readFileSync(join(bridgeDir, file)))
  )

  if (missing.length > 0 || extra.length > 0) {
    fail(
      'pkg/ bridge file set differs from pkg-scalar/ — ' +
        `missing: ${missing.join(', ') || '(none)'}; ` +
        `extra: ${extra.join(', ') || '(none)'}`,
    )
  }
  if (mismatches.length > 0) {
    fail(`pkg/ bridge differs byte-for-byte from pkg-scalar/: ${mismatches.join(', ')}`)
  }
  if (missing.length === 0 && extra.length === 0 && mismatches.length === 0) {
    ok(`pkg/ bridge matches pkg-scalar/ byte-for-byte (${scalarFiles.length} files)`)
  }
}

if (failures.length > 0) {
  console.error(`\n[verify-wasm] ${failures.length} assertion(s) failed`)
  process.exit(1)
}
console.log('[verify-wasm] all WASM artifact assertions passed ✓')
