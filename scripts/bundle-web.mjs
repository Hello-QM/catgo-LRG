// Copy the built SPA (build-desktop/) into the Python package (server/catgo/web/)
// so `python -m build` bundles a working UI into the `catgo` wheel. Run after
// `pnpm desktop:build` and before building the wheel. See server/pyproject.toml
// ([tool.hatch.build.targets.wheel].artifacts) for the whitelist that ships it.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), `..`)
const src = resolve(root, `build-desktop`)
const dst = resolve(root, `server/catgo/web`)

if (!existsSync(resolve(src, `index.html`))) {
  console.error(`✗ build-desktop/index.html not found — run \`pnpm desktop:build\` first`)
  process.exit(1)
}
rmSync(dst, { recursive: true, force: true })
cpSync(src, dst, { recursive: true })
console.log(`✓ bundled SPA → server/catgo/web`)
