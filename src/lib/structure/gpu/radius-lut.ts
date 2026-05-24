import type { Site } from '$lib/structure'
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
 *  species. Used as the GPU radius lookup for atom_radii bond detection. */
export function build_atom_radii(sites: readonly Site[]): Float32Array {
  const out = new Float32Array(sites.length)
  for (let i = 0; i < sites.length; i++) {
    const elem = sites[i].species[0]?.element
    out[i] = (elem != null ? covalent_radius_by_symbol.get(elem) : undefined) ?? DEFAULT_RADIUS
  }
  return out
}
