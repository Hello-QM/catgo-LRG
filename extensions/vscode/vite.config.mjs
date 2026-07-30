import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { mock_vscode } from './tests/vscode-mock'

// this file is trying to load ESM-only packages but it's being loaded as CommonJS by VSCode extension.
// Needs to be explicitly named .mjs to communicate correct import format to VSCode.

const __dirname = fileURLToPath(new URL(`.`, import.meta.url))

export default defineConfig(({ mode }) => ({
  // VS Code serves this bundle from a vscode-webview:// URI. Absolute
  // `/assets/...` URLs resolve against the webview origin and return empty
  // responses; relative URLs stay beside dist/webview.js.
  base: `./`,
  // wasm-bindgen-rayon's threaded glue imports child worker chunks. Vite's
  // default IIFE worker output cannot code-split, so emit module workers.
  worker: {
    format: `es`,
  },
  plugins: [
    mode === `test`
      ? { // just ignore svelte files in test mode
        name: `svelte-mock`,
        resolveId: (id) => id.endsWith(`.svelte`) ? id : null,
        load: (id) => id.endsWith(`.svelte`) ? `export default {}` : null,
      }
      : svelte(),
    mode === `test` ? mock_vscode() : null,
  ],
  define: {
    __CATGO_STATIC_ONLY__: 'false',
    __CATGO_SERVER_URL__: JSON.stringify(''),
    __CATGO_DESKTOP__: 'false',
    __CATGO_VSCODE_EXTENSION__: 'true',
  },
  build: {
    outDir: `dist`,
    rollupOptions: {
      input: resolve(__dirname, `src/webview/main.ts`),
      output: { entryFileNames: `webview.js`, format: `iife` },
    },
    emptyOutDir: false,
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, `../../src/lib`),
      '$app/environment': resolve(__dirname, `src/mocks/app-environment.ts`),
    },
  },
}))
