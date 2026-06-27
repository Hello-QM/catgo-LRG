// Compiled (runes) harness for the wire_trajectory_bond_cache driver effect.
//
// The vitest include glob only collects `*.test.ts`, and the svelte plugin only
// compiles `*.svelte.ts` — so rune syntax ($state / $effect.root) cannot live in
// a `.test.ts`. This `.svelte.ts` module IS compiled and is imported by the
// matching `.test.ts`, which keeps the assertions in a collected test file.

import { flushSync } from 'svelte'
import {
  wire_trajectory_bond_cache,
} from '$lib/structure/trajectory-bond-cache.svelte'
import type { AnyStructure } from '$lib'

type Cache = Parameters<typeof wire_trajectory_bond_cache>[0]

export function make_wire_harness(
  cache: Cache,
  opts: { structure: AnyStructure; show: string },
) {
  let step = $state(0)
  let show = $state(opts.show)
  const positions_getter = () => new Float32Array(12)

  const stop = $effect.root(() => {
    wire_trajectory_bond_cache(cache, {
      get_structure: () => opts.structure,
      get_base: () => opts.structure,
      get_step_idx: () => step,
      get_trajectory_active: () => true,
      get_positions: () => positions_getter,
      get_strategy: () => 'solid_angle',
      get_options: () => ({}),
      get_show_bonds: () => show,
      set_connectivity: () => {},
      get_connectivity: () => null,
    })
  })
  flushSync()

  return {
    set_step: (v: number) => {
      step = v
    },
    set_show: (v: string) => {
      show = v
    },
    flush: () => flushSync(),
    stop,
  }
}
