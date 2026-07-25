import type { ElementSymbol, Site } from '$lib/structure'
import { atomic_radii } from '$lib/structure'
import element_data from '$lib/element/data'

const DEFAULT_RADIUS = 1.0 // Å, fallback for elements with no covalent radius

// element symbol -> covalent radius (Å). Mirrors src/lib/structure/bonding.ts
// so GPU bond radii match the CPU bond path.
const covalent_radius_by_symbol = new Map<string, number>(
  element_data
    .filter((el) => el.covalent_radius != null)
    .map((el) => [el.symbol, el.covalent_radius as number]),
)

/** Per-atom covalent radius (Å), one entry per site, from the site's primary
 *  species. This is the BOND-CUTOFF radius (used by milestone 9.3 bond
 *  detection), NOT the visual sphere size. Do not repurpose for rendering —
 *  use build_display_radii for the impostor sphere radius. */
export function build_atom_radii(sites: readonly Site[]): Float32Array {
  const out = new Float32Array(sites.length)
  for (let i = 0; i < sites.length; i++) {
    const elem = sites[i].species[0]?.element
    out[i] = (elem != null ? covalent_radius_by_symbol.get(elem) : undefined) ?? DEFAULT_RADIUS
  }
  return out
}

/** Impostor-sphere radius scale. The WebGL path resolves a LOGICAL radius in
 *  StructureScene (`atom_data[i].radius`) and then halves it when writing the
 *  instance buffer — see VISUAL_RADIUS_SCALE in
 *  `src/lib/structure/atoms/atom-instanced-renderer.ts` (and the same `* 0.5`
 *  in the legacy AtomImpostors path). Without it the overlay drew every sphere
 *  at 2× the WebGL size. Keep the two in lockstep. */
const VISUAL_RADIUS_SCALE = 0.5

/** Per-atom DISPLAY radius (Å) for the impostor spheres, matching the WebGL
 *  ball-and-stick view's sizing. Mirrors the radius resolution in
 *  StructureScene.svelte:
 *    site_override > same_size_atoms > occu-weighted (element_override | atomic_radii)
 *  all multiplied by the global atom_radius scale AND by VISUAL_RADIUS_SCALE,
 *  which is the halving the WebGL instance writer applies. `atomic_radii` here
 *  is the half-covalent-radius LUT exported from $lib/structure (covalent/2),
 *  the same base the WebGL path uses — distinct from build_atom_radii's full
 *  covalent radius used for bond cutoffs. */
export function build_display_radii(
  sites: readonly Site[],
  opts: {
    atom_radius?: number
    same_size_atoms?: boolean
    element_radius_overrides?: Partial<Record<ElementSymbol, number>>
    site_radius_overrides?: Map<number, number> | { get(k: number): number | undefined }
  } = {},
): Float32Array {
  // VISUAL_RADIUS_SCALE folds in here so it hits all three resolution branches
  // uniformly — the WebGL path likewise halves the FINAL resolved radius,
  // whichever branch produced it.
  const scale = (opts.atom_radius ?? 1) * VISUAL_RADIUS_SCALE
  const same_size = opts.same_size_atoms ?? false
  const ero = opts.element_radius_overrides
  const sro = opts.site_radius_overrides
  const out = new Float32Array(sites.length)
  for (let i = 0; i < sites.length; i++) {
    const site_override = sro?.get(i)
    if (site_override !== undefined) {
      out[i] = site_override * scale
    } else if (same_size) {
      out[i] = scale
    } else {
      // occupancy-weighted sum of per-species radii, matching the WebGL reduce.
      let base = 0
      for (const spec of sites[i].species) {
        const elem = spec.element as ElementSymbol
        base += spec.occu * (ero?.[elem] ?? atomic_radii[elem] ?? 1)
      }
      out[i] = base * scale
    }
  }
  return out
}
