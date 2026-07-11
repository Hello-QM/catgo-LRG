import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

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
    alias: {
      '$lib': resolve(ROOT, 'src/lib'),
      '$site': resolve(ROOT, 'src/site'),
      '$root': ROOT,
      'catgo': resolve(ROOT, 'src/lib'),
      '$app/environment': resolve(ROOT, 'src/lib/mocks/environment.ts'),
      // The real `vscode` module is host-only and unresolvable under vitest.
      // Tests that don't declare their own inline `vi.mock('vscode')` resolve
      // it to this minimal mock instead. Inline `vi.mock('vscode')` still wins
      // for the files that use it.
      'vscode': resolve(__dirname, 'src/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    server: {
      deps: {
        // Inline workspace + Svelte deps so Vite handles their .svelte
        // imports rather than Node's loader (which doesn't know .svelte).
        inline: [/^@threlte\//, /\.svelte$/, 'quickhull3d', 'svelte-styled'],
      },
    },
  },
})
