import { describe, it, expect } from 'vitest'
import { needs_relay, relay_url, RELAY_URL } from '../provider-routing'

describe(`needs_relay`, () => {
  it(`flags Materials Project OPTIMADE host`, () => {
    expect(needs_relay(`https://optimade.materialsproject.org/v1/structures`)).toBe(true)
  })
  it(`passes open CORS providers through directly`, () => {
    expect(needs_relay(`https://alexandria.icams.rub.de/pbe/v1/structures`)).toBe(false)
    expect(needs_relay(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound`)).toBe(false)
  })
})

describe(`relay_url`, () => {
  it(`wraps a target URL as a relay query param`, () => {
    const wrapped = relay_url(`https://optimade.materialsproject.org/v1/structures?x=1`)
    expect(wrapped).toBe(`${RELAY_URL}/?url=${encodeURIComponent(`https://optimade.materialsproject.org/v1/structures?x=1`)}`)
  })
})
