import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'
import { configDefaults, defineConfig } from 'vitest/config'

// Webview tests import code that uses `globalThis.addEventListener` (the
// VSCode webview message bridge), so we need a DOM env. Extension-host
// tests run fine in the same env.
//
// Path aliases mirror svelte.config.js in the parent project so `$lib/*`
// resolves to the top-level src/lib directory.
const ROOT = resolve(__dirname, '../..')

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: [
      // Unit tests exercise webview helpers without building or initializing
      // the Rust workspace's generated WASM package.
      {
        find: /^@catgo\/ferrox-wasm(?:\/.*)?$/,
        replacement: resolve(__dirname, 'src/mocks/ferrox-wasm.ts'),
      },
      { find: '$lib', replacement: resolve(ROOT, 'src/lib') },
      { find: '$site', replacement: resolve(ROOT, 'src/site') },
      { find: '$root', replacement: ROOT },
      { find: 'catgo', replacement: resolve(ROOT, 'src/lib') },
      {
        find: '$app/environment',
        replacement: resolve(ROOT, 'src/lib/mocks/environment.ts'),
      },
      // The real `vscode` module is host-only and unresolvable under vitest.
      // Tests that don't declare their own inline `vi.mock('vscode')` resolve
      // it to this minimal mock instead. Inline `vi.mock('vscode')` still wins
      // for the files that use it.
      { find: 'vscode', replacement: resolve(__dirname, 'src/mocks/vscode.ts') },
    ],
  },
  test: {
    environment: 'happy-dom',
    exclude: process.env.CATGO_SIDECAR_CHILD_MODE
      ? configDefaults.exclude
      : [
          ...configDefaults.exclude,
          'src/__tests__/fixtures/**',
        ],
    server: {
      deps: {
        // Inline workspace + Svelte deps so Vite handles their .svelte
        // imports rather than Node's loader (which doesn't know .svelte).
        inline: [
          '@threlte/core',
          '@threlte/extras',
          'quickhull3d',
          'svelte-styled',
        ],
      },
    },
  },
})
