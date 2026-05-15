import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const __dirname = fileURLToPath(new URL(`.`, import.meta.url))

// The extension runs in VS Code's Node host — every Node builtin must be
// externalized, NOT bundled. Rollup can't bundle a builtin (no JS source);
// a missed one resolves to an empty namespace and the first call on it
// throws "(void 0) is not a function" at runtime (issue #48: node:https +
// node:fs/promises were absent from a hand-maintained list, killing the
// sidecar download). Derive the list from Node so it can't drift again.
const node_builtins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, `src/extension.ts`),
      formats: [`cjs`],
      fileName: () => `extension.cjs`,
    },
    rollupOptions: {
      external: [`vscode`, `ws`, ...node_builtins],
    },
    minify: false,
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, `../../src/lib`),
      '$app/environment': resolve(__dirname, `src/mocks/app-environment.ts`),
    },
  },
  plugins: [svelte()],
})
