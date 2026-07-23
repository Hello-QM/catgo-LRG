import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`trajectory strategy exactness`, () => {
  test(`the exact preparer sends non-atom-radii strategies to object worker`, () => {
    const source = readFileSync(
      `src/lib/structure/trajectory-frame-preparer.ts`,
      `utf8`,
    )
    expect(source).toContain('input.strategy === `atom_radii`')
    expect(source).toContain(`compute_bonds_async(`)
    expect(source).not.toContain(`__CATGO_VSCODE_EXTENSION__`)
  })
})
