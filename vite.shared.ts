/**
 * Shared Vite configuration utilities used by both vite.config.ts (web/SvelteKit)
 * and vite.desktop.config.ts (standalone desktop build).
 *
 * Why two configs:
 *   - Web uses SvelteKit (SSG) with `sveltekit()` plugin, deployed to GitHub Pages
 *   - Desktop uses standalone Vite with `svelte()` plugin, built for Tauri
 *   - Desktop can't use SvelteKit because Tauri needs a plain static build
 *   - Desktop mocks $app/* modules and has custom middleware (DB, PTY, API proxy)
 *
 * What's shared (this file):
 *   - worktree_offset()  — unique dev ports per git worktree
 *   - server_port()      — backend port from env or worktree offset
 *   - shared_define()    — compile-time constants (__CATGO_SERVER_URL__)
 *   - json_gz_plugin()   — decompress .json.gz files at build time
 *
 * What's NOT shared (stays in respective configs):
 *   - ferrox-wasm transform plugin (desktop only — /@fs/ paths)
 *   - $app/* module mocks (desktop only)
 *   - DB/PTY/API middleware (desktop only)
 *   - SvelteKit adapter-static (web only)
 *   - mdsvex plugin (web only)
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Plugin } from 'vite'

/**
 * Auto-assign unique dev ports per worktree so multiple branches run simultaneously.
 * Main repo: offset 0. Worktrees: deterministic 1-99 based on worktree name hash.
 */
export function worktree_offset(): number {
  const dir = resolve(`.`)
  // Match either `.claude/worktrees/<name>` or plain `.worktrees/<name>` —
  // different setups use different layouts; both should produce a stable
  // per-worktree port offset so sibling worktrees do not collide with the
  // main repo or with each other.
  const match = dir.match(/\.(?:claude[/\\])?worktrees[/\\]([^/\\]+)/)
  if (!match) return 0
  let hash = 0
  for (const ch of match[1]) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return 1 + (Math.abs(hash) % 99)
}

/**
 * Compute the backend server port from environment or worktree offset.
 */
export function server_port(offset: number): number {
  return process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT, 10) : 8000 + offset
}

/**
 * Shared `define` constants for both web and desktop builds.
 * Desktop config extends this with `__CATGO_DESKTOP__`.
 */
export function shared_define(srv_port: number): Record<string, string> {
  return {
    __CATGO_SERVER_URL__: JSON.stringify(`http://localhost:${srv_port}`),
  }
}

/**
 * Handle .json.gz files by decompressing them on-the-fly during SSR/build.
 * Both web and desktop configs use this plugin.
 *
 * @param handle_raw - If true, also skip ?raw imports (desktop needs this
 *   because the separate gz-raw plugin handles ?raw). Web config doesn't
 *   have a gz-raw plugin, so it defaults to false.
 */
export function json_gz_plugin(handle_raw = false): Plugin {
  return {
    name: `vite-plugin-json-gz`,
    enforce: `pre`,
    load(id) {
      if (id.includes(`?url`)) return null
      if (handle_raw && id.includes(`?raw`)) return null
      const clean = id.replace(/\?.*$/, ``)
      if (!clean.endsWith(`.json.gz`)) return null
      try {
        const json_data = JSON.parse(gunzipSync(readFileSync(clean)).toString(`utf-8`))
        return { code: `export default ${JSON.stringify(json_data)}`, map: null }
      } catch (error) {
        this.error(`Failed to decompress ${clean}: ${error}`)
      }
    },
  }
}
