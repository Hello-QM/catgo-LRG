import { describe, expect, it } from 'vitest'

import {
  is_newer_version,
  parse_release_manifest,
} from '../release-manifest'

describe(`parse_release_manifest`, () => {
  it(`accepts the Tauri updater manifest fields used by Linux`, () => {
    const manifest = parse_release_manifest({
      version: `1.4.6`,
      notes: `Cloudflare release`,
      pub_date: `2026-07-24T12:00:00Z`,
      platforms: {
        'linux-x86_64': {
          signature: `signed`,
          url: `https://dl.catgo-ucsd.org/v1.4.6/CatGo.AppImage`,
        },
      },
    })

    expect(manifest.version).toBe(`1.4.6`)
    expect(manifest.notes).toBe(`Cloudflare release`)
    expect(manifest.platforms?.[`linux-x86_64`]?.url).toContain(
      `dl.catgo-ucsd.org`,
    )
  })

  it(`normalizes absent notes to null`, () => {
    expect(parse_release_manifest({ version: `v1.4.6` }).notes).toBeNull()
  })

  it.each([
    null,
    [],
    {},
    { version: 146 },
    { version: `not-a-version` },
    { version: `1.4.6`, notes: 10 },
    { version: `1.4.6`, platforms: [] },
  ])(`rejects malformed updater data: %j`, (value) => {
    expect(() => parse_release_manifest(value)).toThrow(/manifest/i)
  })
})

describe(`is_newer_version`, () => {
  it.each([
    [`1.4.6`, `1.4.5`, true],
    [`v1.4.6`, `1.4.6`, false],
    [`1.4.5`, `1.4.6`, false],
    [`1.5.0`, `1.4.99`, true],
    [`1.4.6-beta.1`, `1.4.5`, true],
    [`1.4.6-beta.1`, `1.4.6`, false],
    [`1.4.6`, `1.4.6-beta.9`, true],
    [`1.4.6-beta.10`, `1.4.6-beta.2`, true],
    [`1.4.6-beta`, `1.4.6-Beta`, true],
    [
      `1.4.6-beta.9999999999999999999999999`,
      `1.4.6-beta.9999999999999999999999998`,
      true,
    ],
    [`1.4.6+build.2`, `1.4.6+build.1`, false],
  ])(`compares %s with %s`, (latest, current, expected) => {
    expect(is_newer_version(latest, current)).toBe(expected)
  })

  it.each([
    `latest`,
    `1`,
    `1.2`,
    `1.2.3.4`,
    `01.2.3`,
    `1.02.3`,
    `1.2.03`,
    `1.2.3-01`,
    `1.2.3+`,
    `1.2.3+bad!`,
  ])(`rejects malformed version %s instead of guessing`, (version) => {
    expect(() => is_newer_version(version, `1.4.5`)).toThrow(/version/i)
    expect(() => is_newer_version(`1.4.6`, version)).toThrow(/version/i)
  })
})
