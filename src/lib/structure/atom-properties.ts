// Utility functions for computing atom properties and applying color scales

import type { AnyStructure, Site } from '$lib/structure'
import type { ColorScaleType, D3InterpolateName } from '$lib/colors'
import * as math from '$lib/math'
import type { AtomColorMode } from '$lib/settings'
import type { BondingStrategy } from '$lib/structure/bonding'
import { BONDING_STRATEGIES } from '$lib/structure/bonding'
import type { MoyoDataset } from '@spglib/moyo-wasm'
import { rgb } from 'd3-color'
import * as d3_sc from 'd3-scale-chromatic'

export interface AtomColorConfig {
  mode: AtomColorMode
  scale?: D3InterpolateName
  scale_type: ColorScaleType
  color_fn?: (site: Site, idx: number) => number | string
}

export interface AtomPropertyColors {
  colors: string[] // Color for each site index
  values: (number | string)[] // Property value for each site index
  min_value?: number // For continuous scales
  max_value?: number // For continuous scales
  unique_values?: (number | string)[] // For categorical scales
}

const GRAY = `#808080`
const DEFAULT_COLOR_SCALE = `interpolateViridis`

export const get_d3_color_scales = (): string[] =>
  Object.keys(d3_sc).filter((key) => key.startsWith(`interpolate`))

const get_interpolator = (scale: string) => {
  const interp_fn = d3_sc[scale as keyof typeof d3_sc]
  if (typeof interp_fn !== `function`) {
    console.warn(`Unknown D3 scale: ${scale}, using ${DEFAULT_COLOR_SCALE}`)
    return d3_sc.interpolateViridis
  }
  return interp_fn as (t: number) => string
}

const to_hex = (interp_fn: (t: number) => string, t: number) =>
  rgb(interp_fn(t)).formatHex()

const make_categorical = <T>(
  vals: T[],
  scale: string,
  sort_fn?: (a: T, b: T) => number,
): { colors: string[]; unique_values: T[] } => {
  const interp_fn = get_interpolator(scale)
  const uniq = sort_fn ? [...new Set(vals)].sort(sort_fn) : [...new Set(vals)].sort()
  const colors = uniq.map((_, idx) =>
    to_hex(interp_fn, uniq.length === 1 ? 0.5 : idx / (uniq.length - 1))
  )
  const map = new Map(uniq.map((val, idx) => [val, colors[idx]]))
  return {
    colors: vals.map((val) => map.get(val) ?? GRAY),
    unique_values: uniq,
  }
}

const build_prop_colors = (
  vals: number[],
  colors: string[],
  unique_values?: number[],
): AtomPropertyColors => {
  const uniq = unique_values ?? [...new Set(vals)].sort((val_a, val_b) => val_a - val_b)
  // Use sorted uniq array to avoid spreading large arrays into Math.min/max
  const min_value = uniq.length > 0 ? uniq[0] : undefined
  const max_value = uniq.at(-1)
  return { colors, values: vals, min_value, max_value, unique_values: uniq }
}

export function apply_color_scale(
  vals: number[],
  scale = DEFAULT_COLOR_SCALE,
  type: ColorScaleType = `continuous`,
): { colors: string[]; unique_values?: number[] } {
  if (!vals.length) return { colors: [] }
  if (type === `categorical`) {
    const result = make_categorical(vals, scale, (val_a, val_b) => val_a - val_b)
    return { colors: result.colors, unique_values: result.unique_values }
  }

  const interp_fn = get_interpolator(scale)
  // Compute min/max in single pass to avoid spreading large arrays
  let [min, max] = [vals[0], vals[0]]
  for (const val of vals) {
    if (val < min) min = val
    if (val > max) max = val
  }
  return {
    colors: vals.map((val) =>
      to_hex(interp_fn, max === min ? 0.5 : (val - min) / (max - min))
    ),
  }
}

export const apply_categorical_color_scale = (
  vals: string[],
  scale = DEFAULT_COLOR_SCALE,
): { colors: string[]; unique_values: string[] } =>
  vals.length ? make_categorical(vals, scale) : { colors: [], unique_values: [] }

// Get original site index for property color lookup.
// Supercell atoms use orig_unit_cell_idx, image atoms use orig_site_idx, otherwise use site_idx.
export const get_orig_site_idx = (
  site: Site | undefined,
  site_idx: number,
): number =>
  typeof site?.properties?.orig_unit_cell_idx === `number`
    ? site.properties.orig_unit_cell_idx
    : typeof site?.properties?.orig_site_idx === `number`
    ? site.properties.orig_site_idx
    : site_idx

// Expand structure with PBC images - use minimal expansion based on atom positions
export function expand_structure_for_pbc(structure: AnyStructure): AnyStructure {
  if (!(`lattice` in structure) || !structure.lattice || !structure.sites.length) {
    return structure
  }

  const { sites, lattice } = structure
  const lattice_T = math.transpose_3x3_matrix(lattice.matrix)
  const pbc = lattice.pbc ?? [true, true, true]

  // All valid image offsets respecting PBC
  const all_offsets = [-1, 0, 1]
    .flatMap((dx) =>
      [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dz) => [dx, dy, dz] as const))
    )
    .filter(
      ([dx, dy, dz]) =>
        !(dx === 0 && dy === 0 && dz === 0) &&
        (pbc[0] || dx === 0) &&
        (pbc[1] || dy === 0) &&
        (pbc[2] || dz === 0),
    )

  // Small structures: expand all atoms
  if (sites.length < 20 || !pbc.some((periodic) => periodic)) {
    const image_sites = sites.flatMap((site, orig_idx) =>
      all_offsets.map(([dx, dy, dz]) => {
        const img_abc: math.Vec3 = [site.abc[0] + dx, site.abc[1] + dy, site.abc[2] + dz]
        return {
          ...site,
          abc: img_abc,
          xyz: math.mat3x3_vec3_multiply(lattice_T, img_abc),
          properties: { ...site.properties, orig_site_idx: orig_idx },
        }
      })
    )
    return { ...structure, sites: [...sites, ...image_sites] }
  }

  // Large structures: only expand atoms near boundaries (within 5Å bond distance)
  const cutoff: math.Vec3 = [5.0 / lattice.a, 5.0 / lattice.b, 5.0 / lattice.c]

  const image_sites = sites.flatMap((site, orig_idx) => {
    const norm = site.abc.map((coord) => coord - Math.floor(coord)) as math.Vec3

    return all_offsets
      .filter(
        ([dx, dy, dz]) =>
          // dx=-1 image: atom near boundary 1 (high frac coord) → image shifts it to near 0
          // dx=+1 image: atom near boundary 0 (low frac coord) → image shifts it to near 1
          (dx === 0 || (dx === -1 ? norm[0] >= 1 - cutoff[0] : norm[0] <= cutoff[0])) &&
          (dy === 0 || (dy === -1 ? norm[1] >= 1 - cutoff[1] : norm[1] <= cutoff[1])) &&
          (dz === 0 || (dz === -1 ? norm[2] >= 1 - cutoff[2] : norm[2] <= cutoff[2])),
      )
      .map(([dx, dy, dz]) => {
        const img_abc: math.Vec3 = [site.abc[0] + dx, site.abc[1] + dy, site.abc[2] + dz]
        return {
          ...site,
          abc: img_abc,
          xyz: math.mat3x3_vec3_multiply(lattice_T, img_abc),
          properties: { ...site.properties, orig_site_idx: orig_idx },
        }
      })
  })

  return { ...structure, sites: [...sites, ...image_sites] }
}

export function get_coordination_colors(
  structure: AnyStructure,
  strategy: BondingStrategy = `electroneg_ratio`,
  scale = DEFAULT_COLOR_SCALE,
  type: ColorScaleType = `continuous`,
): AtomPropertyColors {
  const orig_site_count = structure.sites.length

  // Check if structure has periodic boundary conditions
  const has_lattice = `lattice` in structure && structure.lattice !== undefined
  const pbc = has_lattice ? structure.lattice.pbc : undefined
  const has_pbc = has_lattice &&
    (pbc === undefined || pbc.some((is_periodic) => is_periodic))

  // For PBC structures, expand with images from neighboring cells for accurate coordination
  const coord_structure = has_pbc ? expand_structure_for_pbc(structure) : structure

  // Get bonds on the expanded structure
  const bonds = BONDING_STRATEGIES[strategy](coord_structure)

  // Map any site index back to its original atom index.
  // Image atoms (idx >= orig_site_count) have orig_site_idx pointing to the
  // original atom they were cloned from. Without this dedup, bonding to both
  // original B and image_B would count as 2 separate neighbors.
  const to_orig = (idx: number): number => {
    if (idx < orig_site_count) return idx
    const site = coord_structure.sites[idx]
    return typeof site?.properties?.orig_site_idx === `number`
      ? site.properties.orig_site_idx
      : idx
  }

  // Build deduplicated neighbor sets for original atoms only
  const neighbor_sets = new Map<number, Set<number>>()
  for (const { site_idx_1, site_idx_2 } of bonds) {
    const orig_1 = to_orig(site_idx_1)
    const orig_2 = to_orig(site_idx_2)
    if (orig_1 === orig_2) continue // skip self-bonds through images
    // Track neighbors for original atoms
    if (site_idx_1 < orig_site_count) {
      if (!neighbor_sets.has(site_idx_1)) neighbor_sets.set(site_idx_1, new Set())
      neighbor_sets.get(site_idx_1)!.add(orig_2)
    }
    if (site_idx_2 < orig_site_count) {
      if (!neighbor_sets.has(site_idx_2)) neighbor_sets.set(site_idx_2, new Set())
      neighbor_sets.get(site_idx_2)!.add(orig_1)
    }
  }

  const coord_nums = Array.from({ length: orig_site_count }, (_, idx) =>
    neighbor_sets.get(idx)?.size ?? 0,
  )

  const { colors, unique_values } = apply_color_scale(coord_nums, scale, type)
  return build_prop_colors(coord_nums, colors, unique_values)
}

/**
 * Compute coordination colors from pre-computed bonds (async-friendly).
 * Used by Structure.svelte to avoid blocking the main thread — bonds are
 * computed off-thread via the bond Worker, then passed here for color mapping.
 */
export function coordination_colors_from_bonds(
  bonds: { site_idx_1: number; site_idx_2: number }[],
  coord_structure: AnyStructure,
  orig_site_count: number,
  scale = DEFAULT_COLOR_SCALE,
  type: ColorScaleType = `continuous`,
): AtomPropertyColors {
  const to_orig = (idx: number): number => {
    if (idx < orig_site_count) return idx
    const site = coord_structure.sites[idx]
    return typeof site?.properties?.orig_site_idx === `number`
      ? site.properties.orig_site_idx
      : idx
  }

  const neighbor_sets = new Map<number, Set<number>>()
  for (const { site_idx_1, site_idx_2 } of bonds) {
    const orig_1 = to_orig(site_idx_1)
    const orig_2 = to_orig(site_idx_2)
    if (orig_1 === orig_2) continue
    if (site_idx_1 < orig_site_count) {
      if (!neighbor_sets.has(site_idx_1)) neighbor_sets.set(site_idx_1, new Set())
      neighbor_sets.get(site_idx_1)!.add(orig_2)
    }
    if (site_idx_2 < orig_site_count) {
      if (!neighbor_sets.has(site_idx_2)) neighbor_sets.set(site_idx_2, new Set())
      neighbor_sets.get(site_idx_2)!.add(orig_1)
    }
  }

  const coord_nums = Array.from({ length: orig_site_count }, (_, idx) =>
    neighbor_sets.get(idx)?.size ?? 0,
  )

  const { colors, unique_values } = apply_color_scale(coord_nums, scale, type)
  return build_prop_colors(coord_nums, colors, unique_values)
}

export function get_wyckoff_colors(
  structure: AnyStructure,
  sym_data: MoyoDataset | null,
  scale = DEFAULT_COLOR_SCALE,
): AtomPropertyColors {
  const n = structure.sites.length
  if (!sym_data?.orbits || sym_data.orbits.length === 0) {
    return {
      colors: Array(n).fill(GRAY),
      values: Array(n).fill(`unknown`),
      unique_values: [`unknown`],
    }
  }

  // Use orbits to group equivalent atoms. orbits[i] gives the representative
  // atom index in the INPUT cell for atom i. Atoms with the same orbit
  // representative are symmetry-equivalent and share the same Wyckoff position.
  const orbit_ids = structure.sites.map((site, idx) => {
    // Map supercell/image atoms back to original cell index
    const orig_idx = get_orig_site_idx(site, idx)

    if (orig_idx >= sym_data.orbits.length) {
      return `unknown`
    }

    const orbit_rep = sym_data.orbits[orig_idx]
    const element = site.species[0]?.element ?? `?`
    return `orbit_${orbit_rep}|${element}`
  })

  const { colors, unique_values } = apply_categorical_color_scale(orbit_ids, scale)
  return { colors, values: orbit_ids, unique_values }
}

export function get_custom_colors(
  structure: AnyStructure,
  fn: (site: Site, idx: number) => number | string,
  scale = DEFAULT_COLOR_SCALE,
  type: ColorScaleType = `continuous`,
): AtomPropertyColors {
  const vals = structure.sites.map((site, idx) => fn(site, idx))
  const is_num = vals.every((val) => typeof val === `number`)

  if (is_num) {
    const nums = vals as number[]
    const { colors, unique_values } = apply_color_scale(nums, scale, type)
    return build_prop_colors(nums, colors, unique_values)
  }

  const strs = vals.map(String)
  const { colors, unique_values } = apply_categorical_color_scale(strs, scale)
  return { colors, values: strs, unique_values }
}

export function get_charge_colors(
  structure: AnyStructure,
  scale = DEFAULT_COLOR_SCALE,
  type: ColorScaleType = `continuous`,
): AtomPropertyColors {
  const vals = structure.sites.map((site) => {
    const charge = site.properties?.bader_charge
    return typeof charge === `number` ? charge : 0
  })
  const { colors, unique_values } = apply_color_scale(vals, scale, type)
  return build_prop_colors(vals, colors, unique_values)
}

export function get_atom_colors(
  structure: AnyStructure,
  config: Partial<AtomColorConfig>,
  bonding_strategy: BondingStrategy = `electroneg_ratio`,
  sym_data: MoyoDataset | null = null,
): AtomPropertyColors {
  const { mode = `element`, scale = DEFAULT_COLOR_SCALE, scale_type = `continuous` } =
    config

  if (mode === `coordination`) {
    return get_coordination_colors(structure, bonding_strategy, scale, scale_type)
  }
  if (mode === `wyckoff`) return get_wyckoff_colors(structure, sym_data, scale)
  if (mode === `charge`) return get_charge_colors(structure, scale, scale_type)
  if (mode === `mof_sbu`) return { colors: [], values: [] } // async — handled separately in StructureScene
  if (mode === `custom` && config.color_fn) {
    return get_custom_colors(structure, config.color_fn, scale, scale_type)
  }
  // Element mode or custom without function, no property colors needed
  return { colors: [], values: [] }
}

// Helper: Get property colors with null safety check
// Returns null if structure is missing, mode is element, or no colors computed
export function get_property_colors(
  structure: AnyStructure | undefined,
  config: Partial<AtomColorConfig>,
  bonding_strategy: BondingStrategy,
  sym_data: MoyoDataset | null,
): AtomPropertyColors | null {
  if (!structure || config.mode === `element`) return null
  const result = get_atom_colors(structure, config, bonding_strategy, sym_data)
  return result.colors.length ? result : null
}
