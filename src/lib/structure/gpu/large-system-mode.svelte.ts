import type { BondComputeResult } from '$lib/structure/gpu/bond-compute'

type BondConn = { site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }

/** Translate a GPU bond result into the app's bond_connectivity entries.
 *  atom_radii strength is 1.0 (matches Rust detect_bonds_atom_radii). Emits
 *  exactly `result.count` entries (pairs beyond count are ignored / overflow). */
export function result_to_connectivity(result: BondComputeResult): BondConn[] {
  const out: BondConn[] = new Array(result.count)
  for (let i = 0; i < result.count; i++) {
    const p = result.pairs[i]
    out[i] = { site_idx_1: p.a, site_idx_2: p.b, strength: 1, jimage: p.jimage }
  }
  return out
}

/** Manual large-system performance mode. WebGPU availability is injected so the
 *  toggle can refuse + signal fallback when no device. Wired into StructureScene
 *  in Task 9. */
export function create_large_system_mode(deps: {
  has_webgpu: boolean
  on_fallback: (reason: string) => void
}) {
  let enabled = $state(false)
  return {
    get enabled() { return enabled },
    get available() { return deps.has_webgpu },
    enable(): boolean {
      if (!deps.has_webgpu) {
        deps.on_fallback(`WebGPU unavailable — staying on CPU path; very large systems will be capped.`)
        return false
      }
      enabled = true
      return true
    },
    disable(): void { enabled = false },
  }
}

const DEFAULT_MIN_DIST = 0.1
const DEFAULT_TOLERANCE = 0.45
const DEFAULT_MAX_BOND_DIST = 3.0

/** Map the app's bond options (the same tolerance / max_bond_dist the CPU path
 *  uses, driven by the existing UI sliders) into the GPU compute options. This
 *  is what makes "custom bond distance" live-tunable on the GPU path: the
 *  StructureScene loop re-dispatches compute with these whenever a slider
 *  changes. */
export function to_compute_options(opts: Record<string, number>): { tolerance: number; max_bond_dist: number; min_dist: number } {
  return {
    tolerance: opts.tolerance ?? DEFAULT_TOLERANCE,
    max_bond_dist: opts.max_bond_dist ?? DEFAULT_MAX_BOND_DIST,
    min_dist: opts.min_dist ?? DEFAULT_MIN_DIST,
  }
}
