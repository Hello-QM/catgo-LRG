/**
 * Pure render-data computation functions extracted from StructureScene.svelte.
 * No Svelte or Threlte imports — only data in, data out.
 */

import type { Site } from '$lib/structure'
import type { ElementSymbol } from '$lib'
import type { Vec3 } from '$lib/math'

/** Desaturate a hex color by a given factor (0 = fully desaturated, 1 = original). */
export function desaturate_color(color: string, saturation_factor: number): string {
  // Parse hex color
  const hex = color.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16) / 255
  const g = parseInt(hex.substring(2, 4), 16) / 255
  const b = parseInt(hex.substring(4, 6), 16) / 255

  // Convert RGB to HSL
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0,
    s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  // Apply saturation factor
  const new_s = s * saturation_factor

  // Convert HSL back to RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  let nr, ng, nb
  if (new_s === 0) {
    nr = ng = nb = l
  } else {
    const q = l < 0.5 ? l * (1 + new_s) : l + new_s - l * new_s
    const p = 2 * l - q
    nr = hue2rgb(p, q, h + 1 / 3)
    ng = hue2rgb(p, q, h)
    nb = hue2rgb(p, q, h - 1 / 3)
  }

  // Convert back to hex
  const to_hex = (c: number) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to_hex(nr)}${to_hex(ng)}${to_hex(nb)}`
}

/**
 * Element fingerprint — encodes atom count + species. Changes when atoms are
 * added/removed or elements change. Does NOT change for translation/rotation.
 */
export function get_element_fingerprint(sites: Site[]): string {
  if (sites.length <= 200) {
    return sites.map((s) => s.species.map((sp) => sp.element).join(`,`)).join(`;`)
  }
  const n = sites.length
  const first = sites[0]?.species[0]?.element ?? ``
  const last = sites[n - 1]?.species[0]?.element ?? ``
  const mid = sites[Math.floor(n / 2)]?.species[0]?.element ?? ``
  return `${n}:${first}:${mid}:${last}`
}

/** Position hash — lightweight O(n) weighted sum. Changes with any atom move. */
export function get_position_hash(sites: Site[]): number {
  let hash = 0
  for (let i = 0; i < sites.length; i++) {
    const [x, y, z] = sites[i].xyz
    hash += x * (i + 1) + y * (i + 7) + z * (i + 13)
  }
  return hash
}

/** Combined fingerprint: "element_fingerprint|position_hash" */
export function get_structure_fingerprint(sites: Site[]): string {
  return `${get_element_fingerprint(sites)}|${get_position_hash(sites).toFixed(4)}`
}

/** Compute force data from structure sites for arrow rendering. */
export function compute_force_data(
  structure_sites: Site[],
  force_scale: number,
  force_color: string,
  force_color_mode: 'element' | 'custom',
  force_display_mode: 'all' | 'max_only' | 'range',
  element_colors: Record<string, string> | undefined,
  force_range_min?: number,
  force_range_max?: number,
): {
  position: Vec3
  vector: Vec3
  scale: number
  color: string
  magnitude: number
}[] {
  // Collect all forces with their magnitudes
  const all_forces = structure_sites
    .map((site) => {
      if (!site.properties?.force || !Array.isArray(site.properties.force)) return null
      // Skip fully-constrained atoms. VASP still prints a (often large) force on
      // fixed atoms, but it's a constraint reaction, not a relaxation force — it
      // must not dominate the max/range/arrow display. Fixed atoms arrive either as
      // selective_dynamics [F,F,F] (POSCAR/CONTCAR) or move_mask=false (trajectory
      // frames from extxyz / vasprun.xml).
      const sd = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
      if (sd && sd[0] === false && sd[1] === false && sd[2] === false) return null
      if (site.properties?.move_mask === false) return null
      const force = site.properties.force as Vec3
      const magnitude = Math.sqrt(force[0] ** 2 + force[1] ** 2 + force[2] ** 2)
      const majority_element = site.species.reduce((max, spec) =>
        spec.occu > max.occu ? spec : max,
      ).element
      // Use element color if force_color_mode is 'element', otherwise use custom force_color
      const arrow_color =
        force_color_mode === `element`
          ? element_colors?.[majority_element] || force_color
          : force_color
      return {
        position: site.xyz,
        vector: force,
        scale: force_scale,
        color: arrow_color,
        magnitude,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)

  if (force_display_mode === `max_only` && all_forces.length > 0) {
    return [all_forces.reduce((max, f) => f.magnitude > max.magnitude ? f : max)]
  }

  if (force_display_mode === `range` && all_forces.length > 0) {
    const min = force_range_min ?? 0
    const max = force_range_max ?? Infinity
    return all_forces.filter((f) => f.magnitude >= min && f.magnitude <= max)
  }

  return all_forces
}

/** Compute magnetic-moment arrow data from structure sites.
 *
 * Reads `site.properties.magmom`, which pymatgen carries either as a scalar
 * (collinear / ISPIN=2 — the moment is along the spin quantization axis, drawn
 * along +z, sign = up/down) or as a 3-vector [mx,my,mz] (non-collinear — a true
 * direction). Arrows are coloured by the sign of the z-component so spin-up and
 * spin-down read at a glance (red up / blue down). */
export function compute_magmom_data(
  structure_sites: Site[],
  magmom_scale: number,
  up_color: string,
  down_color: string,
): {
  position: Vec3
  vector: Vec3
  scale: number
  color: string
  magnitude: number
}[] {
  return structure_sites
    .map((site) => {
      const raw = site.properties?.magmom as number | number[] | undefined
      if (raw === undefined || raw === null) return null
      let vector: Vec3
      if (typeof raw === `number`) {
        vector = [0, 0, raw]
      } else if (Array.isArray(raw) && raw.length === 3) {
        vector = [raw[0], raw[1], raw[2]] as Vec3
      } else {
        return null
      }
      const magnitude = Math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2)
      // Skip effectively-zero moments (non-magnetic atoms) — no arrow clutter.
      if (magnitude < 1e-3) return null
      return {
        position: site.xyz,
        vector,
        scale: magmom_scale,
        color: vector[2] >= 0 ? up_color : down_color,
        magnitude,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

/**
 * Get the majority element of a site (the species with highest occupancy).
 */
export function get_majority_element(site: Site | undefined): ElementSymbol | null {
  if (!site?.species || site.species.length === 0) return null
  return site.species.reduce(
    (max: Site['species'][number], spec: Site['species'][number]) =>
      spec.occu > max.occu ? spec : max,
  ).element
}

/**
 * Get the color for the majority element of a site, falling back to bond_color.
 */
export function get_majority_color(
  site: Site | undefined,
  element_colors: Record<string, string> | undefined,
  fallback_color: string,
): string {
  const elem = get_majority_element(site)
  if (!elem) return fallback_color
  return element_colors?.[elem] || fallback_color
}
