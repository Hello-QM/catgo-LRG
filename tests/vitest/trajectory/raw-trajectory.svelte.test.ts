import { mark_raw_trajectory } from '$lib/trajectory/trajectory-utils'
import { flushSync } from 'svelte'
import { describe, expect, test } from 'vitest'

// The playback perf contract: the trajectory container is exempt from
// Svelte 5's deep $state proxy (proxy.js only wraps plain objects/arrays),
// so per-frame reads of frames -> structure -> sites pay zero proxy traps.
// These tests pin the exemption against the REAL $state runtime — if a
// Svelte upgrade changes the prototype check, this fails loudly instead of
// silently re-taxing every 20k-atom frame read.

function make_traj() {
  return {
    frames: [
      { structure: { sites: [{ xyz: [0, 0, 0] }] }, step: 0 },
      { structure: { sites: [{ xyz: [1, 1, 1] }] }, step: 1 },
    ],
    metadata: { source_format: `test` },
  }
}

describe(`mark_raw_trajectory — deep-proxy exemption`, () => {
  test(`marked container escapes $state proxying (identity preserved)`, () => {
    const cleanup = $effect.root(() => {
      const marked = mark_raw_trajectory(make_traj())
      let store = $state<Record<string, unknown> | undefined>(undefined)
      store = marked
      flushSync()
      // Unmarked POJOs come back as a proxy (different identity); the marked
      // container must come back untouched — and so must everything below
      // it, since nested proxying only recurses through proxied parents.
      expect(store).toBe(marked)
      expect(store!.frames).toBe(marked.frames)
      const frames = store!.frames as ReturnType<typeof make_traj>[`frames`]
      expect(frames[0].structure.sites[0]).toBe(
        marked.frames[0].structure.sites[0],
      )
    })
    cleanup()
  })

  test(`control: an unmarked POJO IS proxied by deep $state`, () => {
    const cleanup = $effect.root(() => {
      const plain = make_traj()
      let store = $state<Record<string, unknown> | undefined>(undefined)
      store = plain
      flushSync()
      // If this ever starts failing, Svelte changed its proxy semantics and
      // the exemption above needs re-verification.
      expect(store).not.toBe(plain)
    })
    cleanup()
  })

  test(`idempotent and preserves own properties + JSON round-trip`, () => {
    const traj = make_traj()
    const once = mark_raw_trajectory(traj)
    const twice = mark_raw_trajectory(once)
    expect(twice).toBe(traj)
    expect(Object.keys(twice)).toEqual([`frames`, `metadata`])
    expect(JSON.parse(JSON.stringify(twice))).toEqual(make_traj())
  })

  test(`spread of a marked container is a plain POJO again (must re-mark)`, () => {
    const marked = mark_raw_trajectory(make_traj())
    const spread = { ...marked }
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype)
    const remarked = mark_raw_trajectory(spread)
    expect(Object.getPrototypeOf(remarked)).not.toBe(Object.prototype)
  })
})
