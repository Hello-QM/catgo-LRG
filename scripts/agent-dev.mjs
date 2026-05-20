#!/usr/bin/env node
// Wrapper that ensures Bun is on PATH before spawning the agent-bridge
// from source. Without this, `pnpm desktop:serve` (and `pnpm tauri:dev`
// downstream) fails one pane silently with `bun: command not found`,
// which surfaces in CatBot as "Load failed".

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ENTRY = resolve(ROOT, 'src/lib/server/agent-bridge/server.ts')

if (!existsSync(ENTRY)) {
  console.error(`[agent:dev] Entry script not found: ${ENTRY}`)
  process.exit(1)
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const exts = process.platform === 'win32' ? [`.exe`, `.cmd`, ``] : [``]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(dir, cmd + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  // Common user-shell extras VS Code / Tauri may strip
  const home = process.env.HOME || process.env.USERPROFILE || ``
  for (const dir of [`${home}/.bun/bin`, `${home}/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`]) {
    const candidate = resolve(dir, cmd + (process.platform === 'win32' ? `.exe` : ``))
    if (existsSync(candidate)) return candidate
  }
  return null
}

let bun = which('bun')
if (!bun) {
  console.log(`[agent:dev] Bun not found on PATH — auto-installing into ~/.bun via the official installer...`)
  const result = spawn(`bash`, [`-c`, `curl -fsSL https://bun.sh/install | bash`], {
    stdio: 'inherit',
    env: { ...process.env, BUN_INSTALL: `${process.env.HOME}/.bun` },
  })
  await new Promise((resolve) => result.on('exit', resolve))
  bun = which('bun')
  if (!bun) {
    console.error(`
[agent:dev] Bun install attempted but \`bun\` still not on PATH. Common causes:
  - Curl blocked / behind a corp proxy.
  - PATH not refreshed: open a new shell or \`source ~/.bashrc\`.
  - Manual install: \`curl -fsSL https://bun.sh/install | bash\` then add
    \`export PATH="$HOME/.bun/bin:$PATH"\` to your shell rc.

(In production builds the agent bridge ships as a pre-compiled sidecar
binary, so end users don't need Bun.)
`)
    process.exit(2)
  }
  console.log(`[agent:dev] Bun installed at ${bun}. Continuing...`)
}

// Some lab / corp networks hang Node.js fetch (undici) when the DNS
// resolver hands back AAAA first and the IPv6 path is broken. Forcing
// IPv4-first on the runtime + Bun avoids the silent stall that
// otherwise makes CatBot's workflow generation "freeze ~50% of the
// time" on those hosts. Harmless on healthy networks.
// `which('bun')` on Windows often resolves to the npm shim `bun.cmd`.
// Node >=18.20/20.12/22 (CVE-2024-27980) refuses to spawn .cmd/.bat
// without shell:true -> `spawn EINVAL`. shell:true runs it via cmd.exe,
// which resolves the shim. (bun path & ENTRY are space-free here.)
const child = spawn(bun, [`run`, ENTRY], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ``} --dns-result-order=ipv4first`.trim(),
    BUN_DNS_ORDER: `ipv4first`,
  },
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0)
  }
  process.exit(code ?? 1)
})
