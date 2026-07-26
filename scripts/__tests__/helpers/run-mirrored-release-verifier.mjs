import { resolve } from 'node:path'

import { verifyMirroredRelease } from '../../verify-mirrored-release.mjs'

const [tag, assetsDir, sourceRoot, baseUrl, json] = process.argv.slice(2)
const approvedUpdaterPubkey =
  process.env.CATGO_TEST_APPROVED_TAURI_UPDATER_PUBKEY
const trustPolicy = approvedUpdaterPubkey
  ? Object.freeze({ tauriUpdaterPubkey: approvedUpdaterPubkey })
  : undefined

try {
  const report = await verifyMirroredRelease(
    {
      tag,
      assetsDir: resolve(assetsDir),
      sourceRoot: resolve(sourceRoot),
      baseUrl,
    },
    trustPolicy,
  )
  process.stdout.write(
    json === 'true'
      ? `${JSON.stringify(report)}\n`
      : `[release-verify] ${report.tag}: ${report.policy}\n`,
  )
} catch (error) {
  process.stderr.write(`[release-verify] ${error.message}\n`)
  process.exitCode = 1
}
