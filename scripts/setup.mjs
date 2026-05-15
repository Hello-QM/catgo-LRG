#!/usr/bin/env node
/**
 * Preflight + auto-install check for CatGo dev environment.
 *
 *   pnpm setup           # check + offer to install missing deps interactively
 *   pnpm setup --auto    # check + install everything without prompts
 *   pnpm setup --check   # check only; non-zero exit if anything missing
 *
 * What it covers:
 *   - Node 22+
 *   - pnpm 10+
 *   - Python 3.11+
 *   - Bun 1.3+        (agent-bridge dev mode)
 *   - Rust toolchain  (tauri:dev / tauri:build)
 *   - System deps for Tauri on Linux (webkit2gtk, libgtk-3-dev, ...)
 *   - pnpm install for root + extensions/vscode
 *
 * Auto-install paths use the official one-liner for each tool. Anything
 * that needs sudo (Linux apt packages) is printed as a copy-paste hint.
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const argv = process.argv.slice(2)
const AUTO = argv.includes('--auto')
const CHECK_ONLY = argv.includes('--check')

const color = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
}
const ok = (msg) => console.log(`${color.green}✓${color.reset} ${msg}`)
const warn = (msg) => console.log(`${color.yellow}!${color.reset} ${msg}`)
const fail = (msg) => console.log(`${color.red}✗${color.reset} ${msg}`)
const info = (msg) => console.log(`${color.cyan}ℹ${color.reset} ${msg}`)

let rl = null
async function ask(prompt) {
  if (AUTO) return true
  if (CHECK_ONLY) return false
  if (!rl) rl = readline.createInterface({ input, output })
  const ans = (await rl.question(`${prompt} [Y/n] `)).trim().toLowerCase()
  return ans === '' || ans === 'y' || ans === 'yes'
}

function run(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts }).status === 0
}

function try_version(cmd, args = ['--version']) {
  try {
    return execSync(`${cmd} ${args.join(' ')}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { return null }
}

function semver_ge(actual, minimum) {
  const parse = (s) => (s.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1, 4).map(Number)
  const [a1, a2, a3] = parse(actual)
  const [m1, m2, m3] = parse(minimum)
  if (a1 !== m1) return a1 > m1
  if (a2 !== m2) return a2 > m2
  return a3 >= m3
}

const missing = []

// ── Node ──────────────────────────────────────────────────────────────
{
  const v = try_version('node')
  if (!v) {
    fail('Node not found')
    info('  Install Node 22 via nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` then `nvm install 22`')
    missing.push('node')
  } else if (!semver_ge(v, 'v22.0.0')) {
    warn(`Node ${v} (need 22+). Run \`nvm install 22 && nvm use 22\`.`)
    missing.push('node-old')
  } else ok(`Node ${v}`)
}

// ── pnpm ──────────────────────────────────────────────────────────────
{
  const v = try_version('pnpm')
  if (!v) {
    fail('pnpm not found')
    if (await ask('Install pnpm 10 globally via npm?')) {
      run('npm', ['install', '-g', 'pnpm@10'])
    } else { missing.push('pnpm') }
  } else if (!semver_ge(v, '10.0.0')) {
    warn(`pnpm ${v} (need 10+). Upgrade: \`npm install -g pnpm@10\`.`)
    missing.push('pnpm-old')
  } else ok(`pnpm ${v}`)
}

// ── Python ────────────────────────────────────────────────────────────
{
  const v = try_version('python3') || try_version('python')
  if (!v) {
    fail('Python 3.11+ not found')
    info('  Install python3.11+ via your distro package manager.')
    info('  Linux: `sudo apt install python3.11 python3.11-venv`')
    info('  macOS: `brew install python@3.11`')
    missing.push('python')
  } else if (!semver_ge(v, 'Python 3.11.0')) {
    warn(`${v} (need 3.11+).`)
    missing.push('python-old')
  } else ok(v)
}

// ── Bun ───────────────────────────────────────────────────────────────
{
  const v = try_version('bun')
  if (!v) {
    fail('Bun not found (agent-bridge in dev needs it)')
    if (await ask('Install Bun via the official installer?')) {
      run('bash', ['-c', 'curl -fsSL https://bun.sh/install | bash'])
      info('Bun installed. Open a new shell or `source ~/.bashrc` so it lands on PATH.')
    } else {
      info('  Install later: `curl -fsSL https://bun.sh/install | bash`')
      missing.push('bun')
    }
  } else if (!semver_ge(v, '1.3.0')) {
    warn(`Bun ${v} (need 1.3+). Upgrade: \`bun upgrade\`.`)
  } else ok(`Bun ${v}`)
}

// ── Rust + cargo (only required for tauri:dev / tauri:build) ──────────
{
  const v = try_version('cargo')
  if (!v) {
    warn('cargo not found — only needed for `tauri:dev` / `tauri:build`')
    if (await ask('Install Rust via rustup?')) {
      run('bash', ['-c', 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'])
      info('Open a new shell or `source $HOME/.cargo/env` so cargo lands on PATH.')
    } else {
      info('  Install later: `curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh`')
    }
  } else ok(v)
}

// ── Linux-only system deps for Tauri's webkit2gtk webview ─────────────
if (process.platform === 'linux') {
  const has_pkgconfig = try_version('pkg-config', ['--exists', 'webkit2gtk-4.1']) !== null ||
    spawnSync('pkg-config', ['--exists', 'webkit2gtk-4.1'], { stdio: 'ignore' }).status === 0
  if (!has_pkgconfig) {
    warn('webkit2gtk-4.1 development headers not found (Tauri build only).')
    info('  Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev`')
    info('  Fedora:        `sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel`')
  } else ok('webkit2gtk-4.1 (system)')
}

// ── pnpm install (root + extensions/vscode) ──────────────────────────
if (!CHECK_ONLY) {
  const root_lock = resolve(ROOT, 'pnpm-lock.yaml')
  if (existsSync(root_lock)) {
    if (await ask('Run `pnpm install` at repo root?')) {
      run('pnpm', ['install'], { cwd: ROOT })
    }
  }
  const ext_dir = resolve(ROOT, 'extensions/vscode')
  if (existsSync(resolve(ext_dir, 'package.json'))) {
    if (await ask('Run `pnpm install` in extensions/vscode?')) {
      run('pnpm', ['install'], { cwd: ext_dir })
    }
  }
}

if (rl) rl.close()

if (missing.length > 0 && CHECK_ONLY) {
  fail(`Missing: ${missing.join(', ')}`)
  process.exit(1)
}

if (missing.length === 0) {
  ok('All required toolchains present.')
  info('Next: `pnpm desktop:serve`  (or `pnpm tauri:dev` for full desktop app)')
}
