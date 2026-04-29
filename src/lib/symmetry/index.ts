import { ATOMIC_NUMBER_TO_SYMBOL, SYMBOL_TO_ATOMIC_NUMBER } from '$lib/composition/parse'
import type { Vec3 } from '$lib/math'
import { DEFAULTS } from '$lib/settings'
import type { AnyStructure, Crystal } from '$lib/structure'
import type { MoyoCell, MoyoDataset } from '@spglib/moyo-wasm'
import init, { analyze_cell } from '@spglib/moyo-wasm'
import moyo_wasm_url from '@spglib/moyo-wasm/moyo_wasm_bg.wasm?url'

export * from './cell-transform'
export * from './spacegroups'
export { default as SymmetryStats } from './SymmetryStats.svelte'
export { default as WyckoffTable } from './WyckoffTable.svelte'

// Keys are standard crystallographic symbols (P, I, F, A, B, C, R)
export const BRAVAIS_LATTICES = {
  P: `Primitive`,
  I: `Body-centered`,
  F: `Face-centered`,
  A: `A-face centered`,
  B: `B-face centered`,
  C: `C-face centered`,
  R: `Rhombohedral`,
} as const

export type BravaisLattice = (typeof BRAVAIS_LATTICES)[keyof typeof BRAVAIS_LATTICES]

export type SymmetrySettings = {
  symprec: number
  algo: `Moyo` | `Spglib`
}
export const default_sym_settings = {
  symprec: DEFAULTS.symmetry.symprec,
  algo: DEFAULTS.symmetry.algo,
} as const satisfies SymmetrySettings

export type WyckoffPos = {
  wyckoff: string
  elem: string
  abc: Vec3
  site_indices?: number[]
}

let initialized = false

export async function ensure_moyo_wasm_ready(wasm_url?: string) {
  if (initialized) return

  // Use provided URL (e.g. from VSCode webview data), otherwise use Vite-bundled URL
  const url = wasm_url ?? moyo_wasm_url

  await init({ module_or_path: url })
  initialized = true
}

export function to_cell_json(structure: Crystal): string {
  // nalgebra Matrix3 deserializes as a flat list in COLUMN-MAJOR of the internal basis B
  // Internal B = transpose(row-basis RB). column-major(B) == row-major(RB).
  // So supply row-major of the pymatgen lattice.matrix (RB).
  const [v_a, v_b, v_c] = structure.lattice.matrix
  const basis: MoyoCell[`lattice`][`basis`] = [...v_a, ...v_b, ...v_c]
  const positions = structure.sites.map((site) => site.abc)
  const numbers = structure.sites.map((site, idx) => {
    const sym = site.species?.[0]?.element
    const num = sym !== null ? SYMBOL_TO_ATOMIC_NUMBER[sym] : undefined
    if (typeof num !== `number`) {
      throw new Error(`Unknown element at site ${idx}: ${String(sym)}`)
    }
    return num
  })
  const cell: MoyoCell = { lattice: { basis }, positions, numbers }
  return JSON.stringify(cell)
}

export async function analyze_structure_symmetry(
  struct_or_mol: AnyStructure,
  settings: Partial<SymmetrySettings>,
): Promise<MoyoDataset> {
  await ensure_moyo_wasm_ready()
  if (!(`lattice` in struct_or_mol)) {
    throw new Error(`Symmetry analysis requires a periodic structure with a lattice`)
  }
  const cell_json = to_cell_json(struct_or_mol)
  const { symprec, algo } = { ...default_sym_settings, ...settings }
  // Map "Moyo" to "Standard" for moyo-wasm
  const moyo_algo = algo === `Moyo` ? `Standard` : algo
  return analyze_cell(cell_json, symprec, moyo_algo)
}

// Helper function to score coordinate simplicity for Wyckoff table
export function simplicity_score(vec: number[]): number {
  const to_unit = (v: number) => v - Math.floor(v)
  const near_zero = (v: number) => Math.min(v, 1 - v)
  const near_half = (v: number) => Math.abs(v - 0.5)
  const [ax, ay, az] = vec?.map(to_unit) ?? []
  return (
    near_zero(ax) + near_zero(ay) + near_zero(az) +
    0.5 * (near_half(ax) + near_half(ay) + near_half(az))
  )
}

// Generate Wyckoff table rows from symmetry data.
// Uses `orbits` (input-cell indexed) to group atoms from the ORIGINAL structure,
// then matches each group to a Wyckoff letter from `std_cell` by element + multiplicity.
export function wyckoff_positions_from_moyo(
  sym_data: MoyoDataset | null,
  structure?: AnyStructure | null,
): WyckoffPos[] {
  if (!sym_data) return []

  const { orbits, wyckoffs, std_cell } = sym_data

  // --- Step 1: Build Wyckoff letter groups from std_cell ---
  // Groups std_cell atoms by (wyckoff_letter, element) → multiplicity
  const std_wyckoff_groups = new Map<string, { letter: string; elem: string; count: number; positions: Vec3[] }>()
  for (let idx = 0; idx < std_cell.numbers.length; idx++) {
    const full = idx < wyckoffs.length ? wyckoffs[idx] : null
    const letter = (full?.match(/[a-z]+$/)?.[0] ?? full ?? ``).toString()
    const elem = ATOMIC_NUMBER_TO_SYMBOL[std_cell.numbers[idx]] ?? `?`
    const key = `${letter}|${elem}`
    const group = std_wyckoff_groups.get(key) ?? { letter, elem, count: 0, positions: [] }
    group.count++
    group.positions.push(std_cell.positions[idx])
    std_wyckoff_groups.set(key, group)
  }

  // --- Step 2: Group original atoms by orbits ---
  // orbits[i] = representative atom index in input cell for atom i
  if (!orbits || orbits.length === 0) return []

  const orbit_groups = new Map<number, number[]>()
  for (let i = 0; i < orbits.length; i++) {
    const rep = orbits[i]
    if (!orbit_groups.has(rep)) orbit_groups.set(rep, [])
    orbit_groups.get(rep)!.push(i)
  }

  // --- Step 3: Match each orbit group to a std_cell Wyckoff group ---
  // Track which std_cell groups have been matched to avoid double-matching
  const matched_std_keys = new Set<string>()

  const rows: WyckoffPos[] = []
  for (const [rep, indices] of orbit_groups) {
    // Get element from original structure if available, else from orbits length
    let elem: string
    let abc: Vec3
    if (structure && `sites` in structure && structure.sites[rep]) {
      elem = structure.sites[rep].species?.[0]?.element ?? `?`
      abc = structure.sites[rep].abc ?? [0, 0, 0]
    } else {
      // Fallback: can't determine element without structure
      elem = `?`
      abc = [0, 0, 0]
    }

    // Find matching std_cell Wyckoff group by element and multiplicity
    let matched_letter = ``
    let matched_abc = abc
    for (const [key, group] of std_wyckoff_groups) {
      if (matched_std_keys.has(key)) continue
      if (group.elem === elem && group.count === indices.length) {
        matched_letter = group.letter
        matched_std_keys.add(key)
        // Use the simplest std_cell position for display
        matched_abc = group.positions.reduce((best, pos) => {
          const score = simplicity_score(pos)
          return score < best.score ? { pos, score } : best
        }, { pos: group.positions[0], score: simplicity_score(group.positions[0]) }).pos
        break
      }
    }

    // If no match found (e.g. ambiguity), try matching by element only
    if (!matched_letter) {
      for (const [key, group] of std_wyckoff_groups) {
        if (matched_std_keys.has(key)) continue
        if (group.elem === elem) {
          matched_letter = group.letter
          matched_std_keys.add(key)
          matched_abc = group.positions.reduce((best, pos) => {
            const score = simplicity_score(pos)
            return score < best.score ? { pos, score } : best
          }, { pos: group.positions[0], score: simplicity_score(group.positions[0]) }).pos
          break
        }
      }
    }

    const wyckoff = matched_letter ? `${indices.length}${matched_letter}` : `${indices.length}`
    rows.push({ wyckoff, elem, abc: matched_abc, site_indices: indices })
  }

  rows.sort((w1, w2) => {
    const [w1_mult, w2_mult] = [parseInt(w1.wyckoff), parseInt(w2.wyckoff)]
    if (w1_mult !== w2_mult) return w1_mult - w2_mult
    return w1.wyckoff.localeCompare(w2.wyckoff)
  })

  return rows
}

// Apply symmetry operations to find all equivalent positions for a given fractional coordinate
export function apply_symmetry_operations(
  position: Vec3,
  operations: MoyoDataset[`operations`],
  _tolerance = 1e-6,
): Vec3[] {
  const seen = new Set<string>()
  const wrap = (coord: number) => coord - Math.floor(coord)
  const key = (pos: Vec3) => pos.map((coord) => wrap(coord).toFixed(8)).join(`,`)

  return operations
    .map(({ rotation, translation }) => {
      // Apply 3x3 rotation matrix and translation: new_pos = R * position + t
      const new_pos: Vec3 = [0, 1, 2].map((dim) =>
        rotation[dim * 3] * position[0] +
        rotation[dim * 3 + 1] * position[1] +
        rotation[dim * 3 + 2] * position[2] +
        translation[dim]
      ) as Vec3
      return new_pos.map(wrap) as Vec3
    })
    .filter((pos) => {
      const pos_key = key(pos)
      if (seen.has(pos_key)) return false
      seen.add(pos_key)
      return true
    })
}

// Map Wyckoff positions to all equivalent atoms in the displayed structure (including image atoms)
export function map_wyckoff_to_all_atoms(
  wyckoff_positions: WyckoffPos[],
  displayed_structure: Crystal,
  orig_structure: Crystal,
  sym_data: MoyoDataset | null,
  tolerance = 1e-5,
): WyckoffPos[] {
  if (!sym_data?.operations || !displayed_structure.sites || !orig_structure.sites) {
    return wyckoff_positions
  }

  const periodic_distance = (pos1: Vec3, pos2: Vec3) =>
    Math.sqrt(
      pos1.reduce((sum, coord, idx) => {
        // Wrap delta into [-0.5, 0.5) using safe modulo
        const delta = coord - pos2[idx]
        const wrapped = (((delta + 0.5) % 1) + 1) % 1 - 0.5
        const d = Math.abs(wrapped)
        return sum + d * d
      }, 0),
    )

  return wyckoff_positions.map((wyckoff_pos) => {
    const indices = (wyckoff_pos.site_indices || [])
      .filter((idx) => idx < orig_structure.sites.length)
      .flatMap((orig_idx) => {
        const { abc: orig_abc, species } = orig_structure.sites[orig_idx]
        const element = species[0]?.element
        const equivalent_positions = apply_symmetry_operations(
          orig_abc,
          sym_data.operations,
          tolerance,
        )

        return displayed_structure.sites
          .map((site, display_idx) => ({ site, display_idx }))
          .filter(({ site }) => site.species[0]?.element === element)
          .filter(({ site }) =>
            equivalent_positions.some((equiv_pos) =>
              periodic_distance(equiv_pos, site.abc) < tolerance
            )
          )
          .map(({ display_idx }) => display_idx)
      })

    return { ...wyckoff_pos, site_indices: [...new Set(indices)].sort((a, b) => a - b) }
  })
}
