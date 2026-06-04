#!/usr/bin/env node
/**
 * Ensure the gitignored, generated assets a from-source run needs exist before
 * Vite starts, so a fresh clone can `pnpm desktop:dev` (or `desktop:build`)
 * without hitting:
 *   - "Failed to resolve import @catgo/ferrox-wasm" (missing WASM extensions)
 *   - "Failed to resolve import ./docs-chunks.json" (missing RAG chunks)
 *
 * Fast no-op once everything is present (just stat checks). Chained into
 * desktop:dev / desktop:build explicitly because pnpm does not run npm
 * pre/post hooks by default (no `enable-pre-post-scripts`).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runNode = (script, args = []) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: 'inherit' })

// 1) WASM extensions (gitignored) — build only the ones not yet built.
let r = runNode('build-wasm.mjs', ['--if-missing'])
if (r.status !== 0) process.exit(r.status || 1)

// 2) Doc chunks (gitignored) for the in-app RAG.
if (!existsSync(join(ROOT, 'src', 'lib', 'chat', 'docs-chunks.json'))) {
  console.log('[predev] generating docs-chunks.json …')
  r = runNode('build-doc-chunks.js')
  if (r.status !== 0) process.exit(r.status || 1)
}
