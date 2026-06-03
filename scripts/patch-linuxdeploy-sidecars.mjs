#!/usr/bin/env node
// Patch the cached linuxdeploy so it does NOT corrupt our self-contained sidecar
// binaries when building the Linux AppImage.
//
// Why this exists
// ---------------
// tauri bundles two external binaries into the AppImage: `catgo-server`
// (PyInstaller one-file) and `catgo-agent` (Bun-compiled one-file). Both append
// a payload blob after the ELF image. linuxdeploy runs `patchelf --set-rpath`
// on every executable it deploys; rewriting the ELF of a Bun binary shifts the
// payload offset and CORRUPTS it -> the agent segfaults (SIGSEGV) at launch.
// As a knock-on effect linuxdeploy's gtk plugin then runs `ldd` on the now-bad
// binary, ldd exits non-zero, and linuxdeploy aborts -> "failed to run
// linuxdeploy". Fixing the patchelf corruption fixes BOTH symptoms.
//
// What it does
// ------------
// Replaces linuxdeploy's bundled `patchelf` with a shim that is a no-op for
// ELF-modifying ops on `catgo-agent` / `catgo-server` and passes everything
// else through. The patched linuxdeploy is repacked into a real AppImage at the
// same cache path, so tauri uses it transparently (a plain wrapper script does
// NOT survive — tauri rewrites that cache file).
//
// Idempotent: records the patched AppImage's hash in a marker file and skips if
// the cache already holds it. Re-patches if tauri ever re-downloads the cache.
// No-op on non-Linux platforms.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'linux') process.exit(0)

const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'tauri')
const LD = join(CACHE, `linuxdeploy-${ARCH}.AppImage`)
const MARKER = join(CACHE, '.catgo-linuxdeploy-patched')
// Canonical continuous release — only used if tauri has not cached one yet.
const LD_URL = `https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-${ARCH}.AppImage`

const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex')
const log = (m) => console.log(`[patch-linuxdeploy] ${m}`)

// Already patched? (cache file hash matches what we recorded.)
if (existsSync(LD) && existsSync(MARKER) && readFileSync(MARKER, 'utf8').trim() === md5(LD)) {
  log('linuxdeploy already patched — skipping')
  process.exit(0)
}

// Ensure we have an (original) linuxdeploy to patch.
if (!existsSync(LD)) {
  log(`linuxdeploy not cached — downloading ${LD_URL}`)
  execFileSync('curl', ['-fsSL', LD_URL, '-o', LD])
  chmodSync(LD, 0o755)
}

const work = mkdtempSync(join(tmpdir(), 'catgo-linuxdeploy-'))
try {
  log('extracting linuxdeploy')
  execFileSync(LD, ['--appimage-extract'], { cwd: work, stdio: 'ignore' })
  const root = join(work, 'squashfs-root')
  const binDir = join(root, 'usr', 'bin')
  const patchelf = join(binDir, 'patchelf')
  const real = join(binDir, 'patchelf.real')

  if (!existsSync(real)) renameSync(patchelf, real)
  // Shim: skip ELF-modifying ops on the self-contained sidecars; pass the rest
  // through to the real patchelf.
  writeFileSync(patchelf, [
    '#!/bin/sh',
    '# Installed by scripts/patch-linuxdeploy-sidecars.mjs — see that file.',
    'case "$1" in',
    '  --set-rpath|--set-interpreter|--remove-rpath|--shrink-rpath|--force-rpath|--add-needed|--remove-needed|--replace-needed)',
    '    for a in "$@"; do',
    '      case "$a" in *catgo-agent*|*catgo-server*) exit 0 ;; esac',
    '    done ;;',
    'esac',
    'exec "$(dirname "$0")/patchelf.real" "$@"',
    '',
  ].join('\n'))
  chmodSync(patchelf, 0o755)

  // Repack the patched tree into a real AppImage at the cache path, using
  // linuxdeploy's own bundled appimagetool.
  const appimagetool = join(
    root, 'plugins', 'linuxdeploy-plugin-appimage', 'usr', 'bin', 'appimagetool',
  )
  log('repacking patched linuxdeploy')
  rmSync(LD, { force: true })
  execFileSync(appimagetool, [root, LD], {
    env: { ...process.env, ARCH, APPIMAGE_EXTRACT_AND_RUN: '1' },
    stdio: 'ignore',
  })
  chmodSync(LD, 0o755)

  writeFileSync(MARKER, md5(LD))
  log('done — sidecar-safe linuxdeploy installed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
