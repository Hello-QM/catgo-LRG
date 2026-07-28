import type { TrajectoryType } from '$lib/trajectory'
import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/structure/Structure.svelte', async () => ({
  default: (await import('./displayed-frame-owner-probe.svelte')).default,
}))

import Harness from './displayed-frame-owner-harness.svelte'

const in_memory_trajectory = (): TrajectoryType => ({
  frames: [{
    step: 0,
    structure: {
      sites: [{
        species: [{ element: `H`, occu: 1, oxidation_state: 0 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `H`,
        properties: {},
      }],
    },
  }],
})

describe(`displayed frame ownership`, () => {
  it(`publishes the first frame from a plain trajectory held in $state.raw`, async () => {
    const component = mount(Harness, {
      target: document.body,
      props: { trajectory: in_memory_trajectory() },
    })

    try {
      flushSync()
      await tick()
      flushSync()

      const probe = document.querySelector<HTMLElement>(
        `[data-testid="displayed-frame-owner-probe"]`,
      )
      expect(probe).not.toBeNull()
      expect(probe?.dataset.bridgeSites).toBe(`1`)
      expect(probe?.dataset.structureSites).toBe(`1`)
    } finally {
      await unmount(component)
    }
  })
})
