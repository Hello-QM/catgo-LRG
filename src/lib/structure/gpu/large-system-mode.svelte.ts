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
