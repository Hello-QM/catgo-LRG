import { describe, expect, test } from 'vitest'
import { retrieve } from '$lib/chat/rag'

// These tests run against the real docs-chunks.json (built from docs/**/*.md)
// They verify that BM25 retrieval returns relevant results

describe(`rag`, () => {
  test(`returns relevant chunks for slab query`, async () => {
    const results = await retrieve(`how do I build a slab miller index`)
    expect(results.length).toBeGreaterThan(0)
    // At least one result should mention slabs
    const all_content = results.map((r) => r.content.toLowerCase()).join(` `)
    expect(all_content).toContain(`slab`)
  })

  test(`returns relevant chunks for trajectory query`, async () => {
    const results = await retrieve(`play MD trajectory animation`)
    expect(results.length).toBeGreaterThan(0)
    const all_content = results.map((r) => r.content.toLowerCase()).join(` `)
    expect(all_content).toContain(`trajectory`)
  })

  test(`returns relevant chunks for bonding query`, async () => {
    const results = await retrieve(`bonding strategies solid angle`)
    expect(results.length).toBeGreaterThan(0)
    const all_content = results.map((r) => r.content.toLowerCase()).join(` `)
    expect(all_content).toContain(`bond`)
  })

  test(`returns empty array for empty query`, async () => {
    const results = await retrieve(``)
    expect(results).toEqual([])
  })

  test(`respects top_k parameter`, async () => {
    const results = await retrieve(`CatGO structure viewer`, 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  test(`returns results with correct shape`, async () => {
    const results = await retrieve(`phase diagram`)
    expect(results.length).toBeGreaterThan(0)
    for (const chunk of results) {
      expect(chunk).toHaveProperty(`id`)
      expect(chunk).toHaveProperty(`source`)
      expect(chunk).toHaveProperty(`heading`)
      expect(chunk).toHaveProperty(`content`)
      expect(typeof chunk.id).toBe(`number`)
      expect(typeof chunk.source).toBe(`string`)
      expect(typeof chunk.content).toBe(`string`)
    }
  })

  test(`default top_k returns at most 5 results`, async () => {
    const results = await retrieve(`structure visualization atoms bonds lattice cell`)
    expect(results.length).toBeLessThanOrEqual(5)
  })
})
