import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionHostConfig = readFileSync(
  resolve(import.meta.dirname, `../../extensions/vscode/vite.webview.config.ts`),
  `utf8`,
)
const webviewConfig = readFileSync(
  resolve(import.meta.dirname, `../../extensions/vscode/vite.config.mjs`),
  `utf8`,
)

describe(`VS Code Vite WASM resolution`, () => {
  it(`emits ES module workers in both extension builds`, () => {
    expect(extensionHostConfig).toMatch(/worker:\s*\{\s*format:\s*`es`/)
    expect(webviewConfig).toMatch(/worker:\s*\{\s*format:\s*`es`/)
  })

  it(`uses relative asset URLs inside the VS Code webview`, () => {
    expect(webviewConfig).toMatch(/base:\s*`\.\/`/)
  })
})
