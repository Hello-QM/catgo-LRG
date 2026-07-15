import {
  BOND_LOD_MIN_ATOMS,
  BOND_SEGMENTS_FULL,
  BOND_SEGMENTS_LOD,
  bond_lod_segments,
} from '$lib/structure/bonding/bond-lod'
import { describe, expect, test } from 'vitest'

// Cylinder-segment LOD: playback of a large system drops the per-bond
// cylinder to fewer segments (a static frame or a small system keeps full
// segments). Motion hides the segment count; a paused/small view does not.
describe(`bond_lod_segments`, () => {
  test(`small system keeps full segments even during playback`, () => {
    expect(bond_lod_segments(500, true)).toBe(BOND_SEGMENTS_FULL)
    expect(bond_lod_segments(500, false)).toBe(BOND_SEGMENTS_FULL)
  })

  test(`large system drops segments only while playing`, () => {
    expect(bond_lod_segments(20000, true)).toBe(BOND_SEGMENTS_LOD)
    expect(bond_lod_segments(20000, false)).toBe(BOND_SEGMENTS_FULL)
  })

  test(`the threshold is exclusive — exactly MIN_ATOMS is still "small"`, () => {
    expect(bond_lod_segments(BOND_LOD_MIN_ATOMS, true)).toBe(BOND_SEGMENTS_FULL)
    expect(bond_lod_segments(BOND_LOD_MIN_ATOMS + 1, true)).toBe(BOND_SEGMENTS_LOD)
  })

  test(`degenerate atom counts fall back to full segments`, () => {
    expect(bond_lod_segments(0, true)).toBe(BOND_SEGMENTS_FULL)
    expect(bond_lod_segments(-1, true)).toBe(BOND_SEGMENTS_FULL)
    expect(bond_lod_segments(Number.NaN, true)).toBe(BOND_SEGMENTS_FULL)
  })

  test(`LOD segment count is a real reduction, both even for clean geometry`, () => {
    expect(BOND_SEGMENTS_LOD).toBeLessThan(BOND_SEGMENTS_FULL)
    expect(BOND_SEGMENTS_FULL % 2).toBe(0)
    expect(BOND_SEGMENTS_LOD % 2).toBe(0)
  })
})
