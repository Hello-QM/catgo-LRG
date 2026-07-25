export interface ReleasePlatform {
  signature?: string
  url: string
}

export interface ReleaseManifest {
  version: string
  notes: string | null
  pub_date?: string
  platforms?: Record<string, ReleasePlatform>
}

type VersionIdentifier = number | string

interface SemanticVersion {
  core: number[]
  prerelease: VersionIdentifier[] | null
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === `object` && value !== null && !Array.isArray(value)
}

function parse_version(version: string): SemanticVersion {
  if (typeof version !== `string`) {
    throw new Error(`Invalid version: expected a string`)
  }

  const without_prefix = version.replace(/^v/i, ``)
  const [without_build] = without_prefix.split(`+`, 1)
  const separator = without_build.indexOf(`-`)
  const core_text = separator === -1
    ? without_build
    : without_build.slice(0, separator)
  const prerelease_text = separator === -1
    ? null
    : without_build.slice(separator + 1)

  if (!/^\d+(?:\.\d+)*$/.test(core_text)) {
    throw new Error(`Invalid version: ${version}`)
  }
  if (
    prerelease_text !== null &&
    !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(prerelease_text)
  ) {
    throw new Error(`Invalid version: ${version}`)
  }

  const core = core_text.split(`.`).map((part) => Number(part))
  const prerelease = prerelease_text === null
    ? null
    : prerelease_text.split(`.`).map((part) => (
      /^\d+$/.test(part) ? Number(part) : part
    ))

  return { core, prerelease }
}

export function parse_release_manifest(value: unknown): ReleaseManifest {
  if (!is_record(value)) {
    throw new Error(`Invalid release manifest: expected an object`)
  }
  if (typeof value.version !== `string`) {
    throw new Error(`Invalid release manifest: version must be a string`)
  }

  try {
    parse_version(value.version)
  } catch {
    throw new Error(`Invalid release manifest: malformed version`)
  }

  if (
    value.notes !== undefined &&
    value.notes !== null &&
    typeof value.notes !== `string`
  ) {
    throw new Error(`Invalid release manifest: notes must be a string or null`)
  }
  if (value.pub_date !== undefined && typeof value.pub_date !== `string`) {
    throw new Error(`Invalid release manifest: pub_date must be a string`)
  }

  let platforms: Record<string, ReleasePlatform> | undefined
  if (value.platforms !== undefined) {
    if (!is_record(value.platforms)) {
      throw new Error(`Invalid release manifest: platforms must be an object`)
    }
    platforms = {}
    for (const [name, platform_value] of Object.entries(value.platforms)) {
      if (!is_record(platform_value) || typeof platform_value.url !== `string`) {
        throw new Error(`Invalid release manifest: malformed platform ${name}`)
      }
      if (
        platform_value.signature !== undefined &&
        typeof platform_value.signature !== `string`
      ) {
        throw new Error(`Invalid release manifest: malformed signature for ${name}`)
      }
      platforms[name] = {
        url: platform_value.url,
        ...(platform_value.signature === undefined
          ? {}
          : { signature: platform_value.signature }),
      }
    }
  }

  return {
    version: value.version,
    notes: typeof value.notes === `string` ? value.notes : null,
    ...(value.pub_date === undefined ? {} : { pub_date: value.pub_date }),
    ...(platforms === undefined ? {} : { platforms }),
  }
}

function compare_identifiers(
  left: VersionIdentifier,
  right: VersionIdentifier,
): number {
  if (typeof left === `number` && typeof right === `number`) {
    return left - right
  }
  if (typeof left === `number`) return -1
  if (typeof right === `number`) return 1
  return left.localeCompare(right)
}

/** Return true only when latest is a strictly newer semantic version. */
export function is_newer_version(latest: string, current: string): boolean {
  const left = parse_version(latest)
  const right = parse_version(current)

  for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
    const left_part = left.core[index] ?? 0
    const right_part = right.core[index] ?? 0
    if (left_part !== right_part) return left_part > right_part
  }

  if (left.prerelease === null && right.prerelease === null) return false
  if (left.prerelease === null) return true
  if (right.prerelease === null) return false

  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const left_part = left.prerelease[index]
    const right_part = right.prerelease[index]
    if (left_part === undefined) return false
    if (right_part === undefined) return true
    const comparison = compare_identifiers(left_part, right_part)
    if (comparison !== 0) return comparison > 0
  }
  return false
}
