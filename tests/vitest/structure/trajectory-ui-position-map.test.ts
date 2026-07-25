import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`trajectory UI position-map hot path`, () => {
  test(`keeps static atom metadata separate from live trajectory positions`, () => {
    const source = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )

    expect(source).toContain(`let atom_static_maps = $derived.by(() => {`)
    expect(source).toContain(
      `if (!live_atom_position_map_needed) return EMPTY_SITE_POSITION_MAP`,
    )

    const static_start = source.indexOf(`let atom_static_maps = $derived.by(() => {`)
    const static_end = source.indexOf(`const EMPTY_SITE_POSITION_MAP`, static_start)
    const live_start = source.indexOf(`let position_by_site_idx = $derived.by(() => {`)
    expect(static_start).toBeGreaterThan(-1)
    expect(static_end).toBeGreaterThan(static_start)
    expect(live_start).toBeGreaterThan(static_start)

    const static_block = source.slice(static_start, static_end)
    expect(static_block).not.toContain(`atom_manager.version`)
    expect(static_block).not.toContain(`trajectory_frame_positions`)
  })
})
