#!/usr/bin/env node
/**
 * Build the three WASM extensions the frontend imports — ferrox
 * (`@catgo/ferrox-wasm`), chgdiff, and catrender. Their `pkg` outputs are
 * gitignored, so a fresh clone must build them before Vite can resolve the
 * imports (otherwise: "Failed to resolve import @catgo/ferrox-wasm").
 *
 * Mirrors the CI "Build WASM extensions" step, but cross-platform: it spawns
 * wasm-pack with an explicit cwd per crate instead of a shell `cd ... && ...`
 * chain (which is fragile on Windows).
 *
 *   node scripts/build-wasm.mjs              # (re)build all three
 *   node scripts/build-wasm.mjs --if-missing # build only the ones not yet built
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IF_MISSING = process.argv.includes('--if-missing')
const WIN = process.platform === 'win32'

// Per target: the crate dir, the wasm-pack --out-dir (relative to the crate,
// mirroring CI), extra build flags, and the built artifact we probe to decide
// whether it already exists. ferrox keeps the existing `build:wasm` flags
// (--features wasm --no-default-features); chgdiff/catrender match CI.
const TARGETS = [
  {
    name: 'ferrox (@catgo/ferrox-wasm)',
    cwd: join(ROOT, 'extensions', 'rust'),
    outDir: '../rust-wasm/pkg',
    extra: ['--features', 'wasm', '--no-default-features'],
    sentinel: join(ROOT, 'extensions', 'rust-wasm', 'pkg', 'ferrox_bg.wasm'),
  },
  {
    name: 'chgdiff',
    cwd: join(ROOT, 'extensions', 'chgdiff-wasm'),
    outDir: '../../src/lib/electronic/chgdiff-wasm-pkg',
    extra: [],
    sentinel: join(ROOT, 'src', 'lib', 'electronic', 'chgdiff-wasm-pkg', 'chgdiff_wasm_bg.wasm'),
  },
  {
    name: 'catrender',
    cwd: join(ROOT, 'extensions', 'catrender-wasm'),
    outDir: '../../src/lib/structure/catrender/catrender-wasm-pkg',
    extra: [],
    sentinel: join(ROOT, 'src', 'lib', 'structure', 'catrender', 'catrender-wasm-pkg', 'catrender_wasm_bg.wasm'),
  },
]

const pending = IF_MISSING ? TARGETS.filter((t) => !existsSync(t.sentinel)) : TARGETS

if (pending.length === 0) {
  console.log('[build-wasm] all WASM extensions present — nothing to build')
  process.exit(0)
}

// wasm-pack drives cargo to compile Rust → wasm; it must be on PATH.
if (spawnSync('wasm-pack', ['--version'], { stdio: 'ignore', shell: WIN }).status !== 0) {
  console.error([
    '',
    '[build-wasm] `wasm-pack` not found on PATH — needed to build the WASM extensions',
    `             (${pending.map((t) => t.name).join(', ')}).`,
    '',
    '  1. Install Rust:      https://rustup.rs  (run the installer, then open a NEW shell)',
    '  2. Install wasm-pack: cargo install wasm-pack',
    '                        (Windows alt: installer at https://rustwasm.github.io/wasm-pack/installer/)',
    '',
    '  The web build ships pre-built WASM, so this is only needed when running from source.',
    '',
  ].join('\n'))
  process.exit(1)
}

for (const t of pending) {
  console.log(`[build-wasm] building ${t.name} …`)
  const r = spawnSync('wasm-pack', ['build', '--target', 'web', '--out-dir', t.outDir, ...t.extra], {
    cwd: t.cwd,
    stdio: 'inherit',
    shell: WIN,
  })
  if (r.status !== 0) {
    console.error(`[build-wasm] FAILED: ${t.name} (wasm-pack exited ${r.status})`)
    process.exit(r.status || 1)
  }
}
console.log('[build-wasm] all WASM extensions built ✓')
