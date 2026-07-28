export const FORMAT_PRIORITY = {
  windows: ['EXE', 'MSI'],
  macos: ['DMG'],
  linux: ['DEB', 'RPM', 'AppImage'],
  android: ['APK'],
  ios: ['TestFlight'],
}

export function formatForAsset(name) {
  if (/\.msi$/i.test(name)) return 'MSI'
  if (/\.exe$/i.test(name)) return 'EXE'
  if (/\.dmg$/i.test(name)) return 'DMG'
  if (/\.deb$/i.test(name)) return 'DEB'
  if (/\.rpm$/i.test(name)) return 'RPM'
  if (/\.appimage$/i.test(name)) return 'AppImage'
  if (/\.apk$/i.test(name)) return 'APK'
  return null
}

export function platformForAsset(name, format) {
  if (!format || !/^CatGo(?:[_-]|$)/i.test(name)) return null
  if (
    (format === 'EXE' || format === 'MSI') &&
    /(?:^|[_-])(?:x64|x86_64)(?:[_-]|\.)/i.test(name)
  ) {
    return 'windows'
  }
  if (
    format === 'DMG' &&
    /(?:^|[_-])(?:aarch64|arm64)(?:[_-]|\.)/i.test(name)
  ) {
    return 'macos'
  }
  if (format === 'DEB' || format === 'RPM' || format === 'AppImage') {
    return /(?:^|[._-])(?:amd64|x86_64)(?:[._-])/i.test(name)
      ? 'linux'
      : null
  }
  if (
    format === 'APK' &&
    /(?:^|[_-])android(?:[_-]|\.)/i.test(name) &&
    /(?:^|[_-])universal(?:[_-]|\.)/i.test(name)
  ) {
    return 'android'
  }
  return null
}

export function architectureForAsset(platform, name) {
  if (platform === 'windows') {
    return /arm64|aarch64/i.test(name) ? 'ARM64' : 'x64'
  }
  if (platform === 'macos') {
    return /x64|x86_64/i.test(name) ? 'Intel' : 'Apple Silicon'
  }
  if (platform === 'linux') {
    return /aarch64|arm64/i.test(name) ? 'ARM64' : 'amd64'
  }
  return 'Universal'
}

export function isSecondaryDownloadAsset(name) {
  return (
    /\.sig$/i.test(name) ||
    /\.json$/i.test(name) ||
    /\.vsix$/i.test(name) ||
    /\.ipa$/i.test(name) ||
    /\.tar\.(?:gz|xz|zst)$/i.test(name) ||
    /^catgo-server-/i.test(name)
  )
}

export function classifyDownloadAsset(name) {
  const format = formatForAsset(name)
  const platform = platformForAsset(name, format)
  const secondary = isSecondaryDownloadAsset(name)
  return {
    format,
    platform,
    secondary,
    userFacing: platform !== null && !secondary,
    architecture: platform ? architectureForAsset(platform, name) : null,
  }
}

export function comparePlatformDownloads(platform, left, right) {
  const priority = FORMAT_PRIORITY[platform]
  const leftRank = priority.indexOf(left.format)
  const rightRank = priority.indexOf(right.format)
  if (leftRank !== rightRank) return leftRank - rightRank
  return left.name.localeCompare(right.name)
}
