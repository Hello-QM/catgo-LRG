import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { resolve } from 'node:path'

export const WASM_PACK_LICENSE_ARTIFACTS = [
  'extensions/license',
  'src/lib/license',
  'src/lib/structure/license',
]

export function cleanupWasmPackLicenseArtifacts(root) {
  const sourcePath = resolve(root, 'license')
  const source = readFileSync(sourcePath)
  const candidates = []

  for (const relativePath of WASM_PACK_LICENSE_ARTIFACTS) {
    const artifactPath = resolve(root, relativePath)
    if (!existsSync(artifactPath)) continue

    const info = lstatSync(artifactPath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `Refusing to remove non-regular wasm-pack license artifact: ${relativePath}`,
      )
    }
    if (!readFileSync(artifactPath).equals(source)) {
      throw new Error(
        `Refusing to remove unexpected wasm-pack license artifact: ${relativePath}`,
      )
    }
    candidates.push({ artifactPath, relativePath })
  }

  for (const { artifactPath } of candidates) rmSync(artifactPath)
  return candidates.map(({ relativePath }) => relativePath)
}
