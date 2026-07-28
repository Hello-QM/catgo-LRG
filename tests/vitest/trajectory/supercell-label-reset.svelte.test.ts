import type { TrajectoryType } from '$lib/trajectory'
import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/structure/Structure.svelte', async () => ({
  default: (await import('./displayed-frame-owner-probe.svelte')).default,
}))

import Harness from './supercell-label-reset-harness.svelte'

const in_memory_trajectory = (element = `H`): TrajectoryType => ({
  frames: [{
    step: 0,
    structure: {
      sites: [{
        species: [{ element, occu: 1, oxidation_state: 0 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: element,
        properties: {},
      }],
    },
  }],
})

const settle = async () => {
  flushSync()
  await tick()
  flushSync()
}

describe(`supercell label on trajectory replacement`, () => {
  it(`resets the label to 1x1x1 when a new trajectory replaces the old one`, async () => {
    const component = mount(Harness, {
      target: document.body,
      props: { trajectory: in_memory_trajectory(`H`) },
    })
    try {
      await settle()
      component.set_scaling(`2x2x2`)
      await settle()
      expect(component.get_scaling()).toBe(`2x2x2`)

      component.swap_trajectory(in_memory_trajectory(`He`))
      await settle()
      expect(component.get_scaling()).toBe(`1x1x1`)
    } finally {
      await unmount(component)
    }
  })

  it(`preserves the label across spread refreshes of the same trajectory`, async () => {
    const component = mount(Harness, {
      target: document.body,
      props: { trajectory: in_memory_trajectory(`H`) },
    })
    try {
      await settle()
      component.set_scaling(`3x3x3`)
      await settle()

      // flush_pending_ops-style identity refresh: new container object, SAME
      // frames array — must not be treated as a replacement.
      const current = component.get_trajectory()!
      component.swap_trajectory({ ...current })
      await settle()
      expect(component.get_scaling()).toBe(`3x3x3`)
    } finally {
      await unmount(component)
    }
  })
})
