#!/usr/bin/env node
/**
 * Build the WASM extensions the frontend imports — ferrox
 * (`@catgo/ferrox-wasm`, TWO artifacts: scalar + threaded), chgdiff, and
 * catrender. Their outputs are gitignored, so a fresh clone must build them
 * before Vite can resolve the imports (otherwise: "Failed to resolve import
 * @catgo/ferrox-wasm").
 *
 * Mirrors the CI "Build WASM extensions" step, but cross-platform: it spawns
 * wasm-pack with an explicit cwd per crate instead of a shell `cd ... && ...`
 * chain (which is fragile on Windows).
 *
 *   node scripts/build-wasm.mjs                # (re)build everything
 *   node scripts/build-wasm.mjs --if-missing   # build only the ones not yet built
 *   node scripts/build-wasm.mjs --no-simd      # SIMD-less ferrox (ancient WebKit)
 *   node scripts/build-wasm.mjs --only ferrox  # just ferrox (both artifacts)
 *   node scripts/build-wasm.mjs --only=ferrox  # equivalent equals form
 *
 * ferrox dual artifacts (design §8.3 — fast bond backends):
 *
 *   pkg-scalar/    features `wasm-scalar`  — portable SIMD, single thread.
 *                  SIMD128 comes from extensions/rust/.cargo/config.toml
 *                  (`-C target-feature=+simd128`; supported by every engine
 *                  shipped since 2023). `--no-simd` / CATGO_WASM_NO_SIMD=1
 *                  clears RUSTFLAGS for that build, which overrides the
 *                  config-file flag and yields a scalar-only module.
 *   pkg-threaded/  features `wasm-threaded` — WASM threads + SIMD + Rayon via
 *                  wasm-bindgen-rayon. Needs atomics/bulk-memory target
 *                  features and a rebuilt std, so it builds on the NIGHTLY
 *                  toolchain with `-Z build-std=panic_abort,std`. The flags
 *                  are env-scoped HERE so the scalar artifact and native
 *                  `cargo test` never inherit atomics. Install with:
 *                    rustup toolchain install nightly --component rust-src \
 *                      --target wasm32-unknown-unknown
 *                  (CATGO_WASM_NIGHTLY_TOOLCHAIN overrides the toolchain
 *                  name; CATGO_WASM_SKIP_THREADED=1 skips the threaded build
 *                  for local dev — `verify-wasm-artifacts.mjs` will fail, CI
 *                  always builds both.)
 *   pkg/           copy of pkg-scalar/ — bridge so existing
 *                  `@catgo/ferrox-wasm` imports keep resolving.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const IF_MISSING = ARGS.includes('--if-missing')
const NO_SIMD = ARGS.includes('--no-simd') ||
  process.env.CATGO_WASM_NO_SIMD === '1'
const ONLY_VALUES = []
for (let index = 0; index < ARGS.length; index++) {
  const arg = ARGS[index]
  if (arg === '--only') {
    ONLY_VALUES.push(ARGS[index + 1])
    index++
  } else if (arg.startsWith('--only=')) {
    ONLY_VALUES.push(arg.slice('--only='.length))
  }
}
const ONLY = ONLY_VALUES.length === 1 ? ONLY_VALUES[0] : null
const SKIP_THREADED = process.env.CATGO_WASM_SKIP_THREADED === '1'
// CI pins this via CATGO_WASM_NIGHTLY_TOOLCHAIN (workflow-level env in
// .github/workflows/*.yml — nightly churn broke the threaded link flags once
// already); the floating 'nightly' default is for local dev convenience only.
const NIGHTLY = process.env.CATGO_WASM_NIGHTLY_TOOLCHAIN || 'nightly'
const WIN = process.platform === 'win32'

const FERROX_DIR = join(ROOT, 'extensions', 'rust')
const FERROX_PKG = (name) => join(ROOT, 'extensions', 'rust-wasm', name)

// Threaded target features: atomics + bulk-memory (+ mutable-globals, which
// wasm-bindgen-rayon's worker glue requires) + simd128 unless --no-simd.
// NOTE: a set RUSTFLAGS overrides .cargo/config.toml rustflags entirely, so
// +simd128 must be re-added here rather than inherited.
// The link args are EXPLICIT: current nightly rustc no longer auto-adds its
// historical wasm-atomics linker flag set, and without --shared-memory LLD
// silently emits a non-shared exported memory — a module whose thread pool
// can never share state (verify-wasm-artifacts.mjs guards this). The set
// mirrors what rustc's WasmLd used to inject for +atomics (shared/import
// memory + TLS init/size/align/base exports), plus __heap_base which
// wasm-bindgen's threads transform needs for thread-stack allocation
// ("failed to find __heap_base for injecting thread id" otherwise).
// --max-memory is mandatory for shared memories; 2 GiB gives headroom for
// large-trajectory typed buffers while staying allocatable in browsers.
// (no --export=__wasm_init_memory: current LLD runs memory init from the
// wasm start function and no longer synthesizes that symbol — exporting it
// is a hard link error "symbol exported via --export not found".)
const THREADED_LINK_ARGS = [
  '--shared-memory',
  '--import-memory',
  '--max-memory=2147483648',
  '--export=__wasm_init_tls',
  '--export=__tls_size',
  '--export=__tls_align',
  '--export=__tls_base',
  '--export=__heap_base',
]
const THREADED_RUSTFLAGS = '-C target-feature=+atomics,+bulk-memory,+mutable-globals' +
  (NO_SIMD ? '' : ',+simd128') +
  THREADED_LINK_ARGS.map((a) => ` -C link-arg=${a}`).join('')

// Per target: the crate dir, the wasm-pack --out-dir (relative to the crate,
// mirroring CI), extra build flags, and the built artifact(s) we probe to
// decide whether it already exists.
const TARGETS = [
  {
    key: 'ferrox',
    name: 'ferrox scalar (@catgo/ferrox-wasm pkg-scalar)',
    cwd: FERROX_DIR,
    outDir: '../rust-wasm/pkg-scalar',
    extra: ['--features', 'wasm-scalar', '--no-default-features'],
    // pkg/ is derived from pkg-scalar/ (see post) — rebuild if either is gone.
    sentinels: [
      join(FERROX_PKG('pkg-scalar'), 'ferrox_bg.wasm'),
      join(FERROX_PKG('pkg'), 'ferrox_bg.wasm'),
    ],
    // A set (even empty) RUSTFLAGS overrides .cargo/config.toml target
    // rustflags — this is the documented no-SIMD escape hatch.
    env: NO_SIMD ? { ...process.env, RUSTFLAGS: '' } : undefined,
    // Bridge: existing imports resolve @catgo/ferrox-wasm → pkg/. Keep it a
    // byte-for-byte copy of the scalar artifact.
    post: () => {
      rmSync(FERROX_PKG('pkg'), { recursive: true, force: true })
      cpSync(FERROX_PKG('pkg-scalar'), FERROX_PKG('pkg'), { recursive: true })
      console.log('[build-wasm] copied pkg-scalar/ → pkg/ (legacy import bridge)')
    },
  },
  {
    key: 'ferrox',
    name: 'ferrox threaded (@catgo/ferrox-wasm pkg-threaded)',
    cwd: FERROX_DIR,
    outDir: '../rust-wasm/pkg-threaded',
    extra: ['--features', 'wasm-threaded', '--no-default-features'],
    sentinels: [join(FERROX_PKG('pkg-threaded'), 'ferrox_bg.wasm')],
    env: {
      ...process.env,
      RUSTUP_TOOLCHAIN: NIGHTLY,
      RUSTFLAGS: THREADED_RUSTFLAGS,
      // std must be rebuilt with atomics (nightly-only). Env form of
      // `-Z build-std=panic_abort,std` — wasm-pack 0.14 mis-forwards `--`
      // extra cargo args ("unexpected argument '-Z'"), the env var works
      // across wasm-pack versions.
      CARGO_UNSTABLE_BUILD_STD: 'panic_abort,std',
    },
    threaded: true,
  },
  {
    key: 'chgdiff',
    name: 'chgdiff',
    cwd: join(ROOT, 'extensions', 'chgdiff-wasm'),
    outDir: '../../src/lib/electronic/chgdiff-wasm-pkg',
    extra: [],
    sentinels: [
      join(ROOT, 'src', 'lib', 'electronic', 'chgdiff-wasm-pkg', 'chgdiff_wasm_bg.wasm'),
    ],
  },
  {
    key: 'catrender',
    name: 'catrender',
    cwd: join(ROOT, 'extensions', 'catrender-wasm'),
    outDir: '../../src/lib/structure/catrender/catrender-wasm-pkg',
    extra: [],
    sentinels: [
      join(
        ROOT,
        'src',
        'lib',
        'structure',
        'catrender',
        'catrender-wasm-pkg',
        'catrender_wasm_bg.wasm',
      ),
    ],
  },
]

const VALID_TARGET_KEYS = [...new Set(TARGETS.map((target) => target.key))]
const INVALID_ONLY = ONLY_VALUES.length !== 1 || !ONLY || !VALID_TARGET_KEYS.includes(ONLY)
if (ONLY_VALUES.length > 0 && INVALID_ONLY) {
  const shownValue = ONLY_VALUES.length > 1 ? '(multiple)' : ONLY || '(missing)'
  console.error(
    `[build-wasm] invalid value for --only: ${shownValue}\n` +
      `             valid targets: ${VALID_TARGET_KEYS.join(', ')}`,
  )
  process.exit(2)
}

let pending = TARGETS
if (ONLY) pending = pending.filter((t) => t.key === ONLY)
if (IF_MISSING) pending = pending.filter((t) => t.sentinels.some((s) => !existsSync(s)))
if (SKIP_THREADED) {
  const skipped = pending.filter((t) => t.threaded)
  if (skipped.length > 0) {
    console.warn(
      '[build-wasm] WARNING: CATGO_WASM_SKIP_THREADED=1 — skipping the threaded ' +
        'ferrox artifact. verify-wasm-artifacts.mjs WILL fail; never set this in CI.',
    )
  }
  pending = pending.filter((t) => !t.threaded)
}

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

// The threaded artifact rebuilds std with atomics — that needs the nightly
// toolchain plus its rust-src component. Preflight for an actionable error
// instead of an opaque cargo failure mid-build.
if (pending.some((t) => t.threaded)) {
  const probe = spawnSync('rustup', ['run', NIGHTLY, 'rustc', '--version'], {
    stdio: 'ignore',
    shell: WIN,
  })
  const components = spawnSync(
    'rustup',
    ['component', 'list', '--toolchain', NIGHTLY, '--installed'],
    { encoding: 'utf8', shell: WIN },
  )
  const hasSrc = components.status === 0 && /(^|\n)rust-src/.test(components.stdout || '')
  if (probe.status !== 0 || !hasSrc) {
    console.error([
      '',
      `[build-wasm] the threaded ferrox artifact needs the \`${NIGHTLY}\` toolchain`,
      '             with rust-src (std is rebuilt with atomics). Install it with:',
      '',
      `  rustup toolchain install ${NIGHTLY} --component rust-src --target wasm32-unknown-unknown`,
      '',
      '  Local-dev escape hatch (CI must never use it): CATGO_WASM_SKIP_THREADED=1',
      '',
    ].join('\n'))
    process.exit(1)
  }
}

for (const t of pending) {
  console.log(`[build-wasm] building ${t.name} …`)
  const r = spawnSync('wasm-pack', ['build', '--target', 'web', '--out-dir', t.outDir, ...t.extra], {
    cwd: t.cwd,
    stdio: 'inherit',
    shell: WIN,
    env: t.env,
  })
  if (r.status !== 0) {
    console.error(`[build-wasm] FAILED: ${t.name} (wasm-pack exited ${r.status})`)
    process.exit(r.status || 1)
  }
  if (t.post) t.post()
}
console.log('[build-wasm] all WASM extensions built ✓')
