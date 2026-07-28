import { expect, test } from 'vitest'

import {
  download_verified_sidecar_from_origin,
  stored_sidecar_is_verified,
} from '../../sidecar'

const mode = process.env.CATGO_SIDECAR_CHILD_MODE
const child_test = mode ? test : test.skip

child_test(`coordinates one sidecar target across extension-host processes`, async () => {
  const base_url = process.env.CATGO_SIDECAR_CHILD_BASE_URL
  const destination = process.env.CATGO_SIDECAR_CHILD_DESTINATION
  const asset_name = process.env.CATGO_SIDECAR_CHILD_ASSET_NAME
  if (!base_url || !destination || !asset_name || !mode) {
    throw new Error(`Missing sidecar child-process test environment`)
  }

  if (!(await stored_sidecar_is_verified(destination, asset_name))) {
    await download_verified_sidecar_from_origin({
      binary_url: `${base_url}/${mode}/${asset_name}`,
      checksum_url: `${base_url}/${mode}/${asset_name}.sha256`,
      destination,
      asset_name,
    }, base_url)
  }

  await expect(
    stored_sidecar_is_verified(destination, asset_name),
  ).resolves.toBe(true)
})
