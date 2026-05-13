#!/usr/bin/env node
/**
 * Compile src/lib/server/agent-bridge/server.ts into a single-file Bun
 * executable for the current host platform, written into
 * src-tauri/binaries/ under the Tauri-required `<name>-<rust-triple>`
 * filename.  Tauri's bundler picks it up via `externalBin` in
 * tauri.conf.json and ships it as a sidecar alongside catgo-server.
 *
 * Usage (CI auto-runs this in the WASM-extensions step or before tauri
 * build; local devs can also invoke it directly):
 *   pnpm build:agent          # auto-detect host platform
 *   pnpm build:agent linux    # force linux-x64 target
 *   pnpm build:agent mac-arm  # force darwin-arm64 target
 *   pnpm build:agent win      # force windows-x64 target
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Map host (or explicit override) to Bun target + Rust triple.
const PRESETS = {
  linux:    { bun: 'bun-linux-x64-modern',     triple: 'x86_64-unknown-linux-gnu',  ext: '' },
  'linux-arm':  { bun: 'bun-linux-arm64',      triple: 'aarch64-unknown-linux-gnu', ext: '' },
  'mac-arm':    { bun: 'bun-darwin-arm64',     triple: 'aarch64-apple-darwin',      ext: '' },
  'mac-intel':  { bun: 'bun-darwin-x64',       triple: 'x86_64-apple-darwin',       ext: '' },
  win:          { bun: 'bun-windows-x64-modern', triple: 'x86_64-pc-windows-msvc',   ext: '.exe' },
}

function detect() {
  const override = process.argv[2]
  if (override) {
    if (!(override in PRESETS)) {
      console.error(`Unknown preset "${override}". Valid: ${Object.keys(PRESETS).join(', ')}`)
      process.exit(2)
    }
    return PRESETS[override]
  }
  if (platform === 'linux'  && arch === 'x64')   return PRESETS['linux']
  if (platform === 'linux'  && arch === 'arm64') return PRESETS['linux-arm']
  if (platform === 'darwin' && arch === 'arm64') return PRESETS['mac-arm']
  if (platform === 'darwin' && arch === 'x64')   return PRESETS['mac-intel']
  if (platform === 'win32'  && arch === 'x64')   return PRESETS['win']
  console.error(`Unsupported host: ${platform}/${arch}. Pass a preset arg: ${Object.keys(PRESETS).join(', ')}`)
  process.exit(2)
}

const preset = detect()
const binDir = resolve(ROOT, 'src-tauri', 'binaries')
if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
const outfile = resolve(binDir, `catgo-agent-${preset.triple}${preset.ext}`)
const entry   = resolve(ROOT, 'src', 'lib', 'server', 'agent-bridge', 'server.ts')

const cmd = [
  'bun build',
  JSON.stringify(entry),
  '--compile',
  `--target=${preset.bun}`,
  `--outfile=${JSON.stringify(outfile)}`,
].join(' ')

console.log(`[build:agent] ${preset.bun} -> ${outfile}`)
execSync(cmd, { stdio: 'inherit', cwd: ROOT })
console.log(`[build:agent] done`)
