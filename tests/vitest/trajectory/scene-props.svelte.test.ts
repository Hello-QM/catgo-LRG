import { flushSync, mount, tick, unmount } from 'svelte'
import { expect, it, vi } from 'vitest'

vi.mock('$lib/structure/Structure.svelte', async () => ({
  default: (await import('./scene-props-probe.svelte')).default,
}))
import Harness from './scene-props-harness.svelte'
import Probe from './scene-props-probe.svelte'

it('passes the requested nested scene properties to the real Trajectory child', async () => {
  const scene = { bond_scale: 1.37, bonding_strategy: 'atom_radii', show_bonds: 'never' }
  const component = mount(Harness, {
    target: document.body,
    props: {
      scene,
      trajectory: { frames: [{ step: 0, structure: { sites: [{
        species: [{ element: 'H', occu: 1, oxidation_state: 0 }],
        abc: [0, 0, 0], xyz: [0, 0, 0], label: 'H', properties: {},
      }] } }] },
    },
  })
  try {
    flushSync()
    await tick()
    flushSync()
    const received = document.querySelector<HTMLElement>('[data-testid="scene-props-probe"]')?.dataset.scene
    expect(received).toBeDefined()
    expect(JSON.parse(received!)).toEqual(scene)
  } finally { await unmount(component) }
})

it('the prop probe receives the same settings when passed directly', async () => {
  const scene = { bond_scale: 1.37, bonding_strategy: 'atom_radii', show_bonds: 'never' }
  const component = mount(Probe, { target: document.body, props: { scene_props: scene } })
  try {
    flushSync()
    await tick()
    expect(JSON.parse(document.querySelector<HTMLElement>('[data-testid="scene-props-probe"]')!.dataset.scene!))
      .toEqual(scene)
  } finally { await unmount(component) }
})
