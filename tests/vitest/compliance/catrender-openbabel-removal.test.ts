import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(path, `utf8`)
const readRustProduction = (path: string) => read(path).split(`\n#[cfg(test)]`)[0]

describe(`CatRender bond-order release source`, () => {
  test(`contains no Open Babel-derived perception implementation`, () => {
    expect(existsSync(`extensions/catrender-wasm/src/perceive.rs`)).toBe(false)
    expect(
      existsSync(`docs/superpowers/plans/2026-05-21-catrender-ob-bond-perception.md`),
    ).toBe(false)

    const production = [
      `extensions/catrender-wasm/src/bonds.rs`,
      `extensions/catrender-wasm/src/element_data.rs`,
      `extensions/catrender-wasm/src/lib.rs`,
      `extensions/catrender-wasm/src/svg.rs`,
      `extensions/catrender-wasm/src/types.rs`,
    ]
      .map(readRustProduction)
      .concat([
        `scripts/generate-catrender-covalent-radii.mjs`,
        `src/lib/structure/catrender/catrender-state.svelte.ts`,
        `src/lib/structure/catrender/CatRenderParamsPane.svelte`,
        `src/lib/structure/catrender/CatRenderViewPane.svelte`,
      ].map(read))
      .join(`\n`)

    expect(production).not.toMatch(
      /OBMol::PerceiveBondOrders|OpenBabel-style|mod perceive|perceive_orders/,
    )
    expect(read(`third_party/provenance/catrender-bond-order-removal.md`)).toContain(
      `7ba0614b1fa51116f49dbbc669940e7af7df716a`,
    )
    expect(read(`THIRD_PARTY_NOTICES.md`)).toContain(
      `removed from the current release tree`,
    )
    expect(read(`extensions/vscode/THIRD_PARTY_NOTICES.md`)).toContain(
      `removed from the current release tree`,
    )
  })
})
