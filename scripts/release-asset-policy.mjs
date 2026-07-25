const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/
const USER_FACING_RELEASE_ASSET = [
  /^CatGo_\d+\.\d+\.\d+_(?:x64|aarch64)(?:_[A-Za-z0-9-]+)?(?:-setup)?\.(?:exe|msi|dmg)$/i,
  /^CatGo_\d+\.\d+\.\d+_(?:amd64|aarch64)\.(?:deb|AppImage)$/i,
  /^CatGo-\d+\.\d+\.\d+-\d+\.(?:x86_64|aarch64)\.rpm$/i,
  /^CatGo-v\d+\.\d+\.\d+-android-universal\.apk$/i,
  /^catgo-\d+\.\d+\.\d+\.vsix$/i,
]

function versionForTag(tag) {
  const match = RELEASE_TAG.exec(tag)
  if (!match) throw new Error(`Invalid CatGo release tag: ${tag}`)
  return match[1]
}

export function requiredReleaseAssets(tag) {
  const version = versionForTag(tag)
  return [
    {
      label: 'Windows NSIS installer',
      name: `CatGo_${version}_x64-setup.exe`,
    },
    {
      label: 'Windows MSI installer',
      name: `CatGo_${version}_x64_en-US.msi`,
    },
    {
      label: 'macOS Apple Silicon DMG',
      name: `CatGo_${version}_aarch64.dmg`,
    },
    {
      label: 'macOS Apple Silicon updater archive',
      name: 'CatGo_aarch64.app.tar.gz',
    },
    {
      label: 'Linux DEB installer',
      name: `CatGo_${version}_amd64.deb`,
    },
    {
      label: 'Linux RPM installer',
      name: `CatGo-${version}-1.x86_64.rpm`,
    },
    {
      label: 'Android universal APK',
      name: `CatGo-v${version}-android-universal.apk`,
    },
    {
      label: 'HPC bundle',
      name: 'catgo-hpc-bundle.tar.gz',
    },
    {
      label: 'VS Code extension',
      name: `catgo-${version}.vsix`,
    },
  ]
}

export function requiredUpdaterPlatforms(tag) {
  const version = versionForTag(tag)
  return [
    {
      platform: 'windows-x86_64',
      asset: `CatGo_${version}_x64-setup.exe`,
    },
    {
      platform: 'darwin-aarch64',
      asset: 'CatGo_aarch64.app.tar.gz',
    },
  ]
}

export function verifyRequiredReleaseAssets(assetNames, tag) {
  const assets = assetNames instanceof Set ? assetNames : new Set(assetNames)
  const requirements = requiredReleaseAssets(tag)
  for (const requirement of requirements) {
    if (!assets.has(requirement.name)) {
      throw new Error(
        `Release is missing required release asset for ${requirement.label}: ` +
          requirement.name,
      )
    }
  }

  const version = versionForTag(tag)
  const allowedUserFacingAssets = new Set([
    ...requirements.map((requirement) => requirement.name),
    `CatGo_${version}_amd64.AppImage`,
  ])
  for (const asset of assets) {
    if (
      USER_FACING_RELEASE_ASSET.some((pattern) => pattern.test(asset)) &&
      !allowedUserFacingAssets.has(asset)
    ) {
      throw new Error(
        `Unexpected release installer for ${tag}: ${asset}`,
      )
    }
  }
}
