import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import { json_gz_plugin } from './vite.shared'

export default defineConfig({
  plugins: [svelte({ hot: false }), json_gz_plugin(true)],
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      '$site': resolve(__dirname, 'src/site'),
      '$root': resolve(__dirname, '.'),
      'catgo': resolve(__dirname, 'src/lib'),
      // SvelteKit's $app/* modules aren't available outside a SvelteKit
      // build; route them at the local mocks so unit tests can import code
      // that depends on `browser`/`dev`/`building` flags.
      '$app/environment': resolve(__dirname, 'src/lib/mocks/environment.ts'),
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/vitest/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    globals: false,
    // quickhull3d ships an ESM index.js that imports `./QuickHull` without
    // an extension. Node's ESM resolver rejects that — force Vite to
    // bundle the package so its module-graph transform fills the extension.
    server: {
      deps: {
        inline: ['quickhull3d'],
      },
    },
  },
})
