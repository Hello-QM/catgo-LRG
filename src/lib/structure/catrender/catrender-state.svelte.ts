// catrender shared reactive state — the SINGLE source of truth shared by
// CatRenderParamsPane (writer) and CatRenderViewPane (reader/renderer).
//
// RT13: the pane was split into two INDEPENDENT DraggablePanes. Both import
// this module — params are NOT prop-drilled and NOT duplicated. A Svelte 5
// `.svelte.ts` module exporting a `$state` class instance is the established
// cross-component shared-store pattern; importing the instance gives both
// panes the same reactive object.
//
// Pure helpers (`build_overrides`, `prune_atom_idx`) carry the override
// projection logic out of the .svelte files so they are unit-testable under
// __tests__/. The .svelte panes only wire UI ↔ this state.

import type { BondOverride } from './bond-merge'
import type { AtomOverride } from './atom-merge'

// Full 12-preset set (spec §"13 presets"; overlay is internal but exposed).
export const PRESETS = [
  `default`, `flat`, `paton`, `skeletal`, `bubble`, `tube`, `mtube`,
  `btube`, `wire`, `graph`, `pmol`, `overlay`,
] as const
export type Preset = (typeof PRESETS)[number]

// Axis gizmo colours — default.json `axis_colors` [firebrick,forestgreen,
// royalblue] (X red, Y green, Z blue).
export const AXIS_COLORS = [`firebrick`, `forestgreen`, `royalblue`] as const

// A live-tunable knob: `on` gates whether it pins a value into the override
// map (untouched = inherit preset). `v` is the current control value.
export type Knob<T> = { on: boolean; v: T }

// JSON-key for each dedicated knob → the key emitted into style.overrides.
// Single declarative source consumed by both the UI (label list) and
// `build_overrides` (projection) so the two never drift.
export const KNOB_KEYS = {
  k_atom_scale: `atom_scale`,
  k_bond_width: `bond_width`,
  k_atom_stroke_width: `atom_stroke_width`,
  k_hue: `hue_shift_factor`,
  k_light: `light_shift_factor`,
  k_sat: `saturation_shift_factor`,
  k_fog_strength: `fog_strength`,
  k_label_font_size: `label_font_size`,
  k_gradient: `gradient`,
  k_fog: `fog`,
  k_bond_orders: `bond_orders`,
  k_bond_color_by_element: `bond_color_by_element`,
  k_bond_gradient: `bond_gradient`,
  k_atoms_above_bonds: `atoms_above_bonds`,
  k_bond_color: `bond_color`,
  k_background: `background`,
  k_cell_color: `cell_color`,
} as const
export type KnobName = keyof typeof KNOB_KEYS

/**
 * PURE projection: dedicated knobs (only `on` ones) ← advanced raw JSON.
 * Returns `{ map, err }` — no side effects (a Svelte 5 footgun otherwise).
 * Malformed advanced JSON → `err` set + `map` is the last-good dedicated
 * map (advanced merge skipped). Mirrors the original CatRenderPane derived.
 */
export function build_overrides(
  knobs: Record<KnobName, Knob<number | boolean | string>>,
  advanced_json: string,
): { map: Record<string, unknown>; err: string } {
  const o: Record<string, unknown> = {}
  let err = ``
  for (const name of Object.keys(KNOB_KEYS) as KnobName[]) {
    const k = knobs[name]
    if (k?.on) o[KNOB_KEYS[name]] = k.v
  }
  if (advanced_json.trim()) {
    try {
      const parsed = JSON.parse(advanced_json)
      if (parsed && typeof parsed === `object` && !Array.isArray(parsed))
        Object.assign(o, parsed)
      else err = `advanced JSON must be an object`
    } catch (e) {
      err = `advanced JSON: ${String(e)}`
    }
  }
  return { map: o, err }
}

/** Clamp an atom index into a valid structure range (≥0, <n). */
export function prune_atom_idx(idx: number, n: number): number | null {
  return Number.isFinite(idx) && idx >= 0 && idx < n ? Math.trunc(idx) : null
}

// Mirror of the read-only structure the view pane renders: atoms / base
// connectivity / lattice / count. The Structure component owns the source
// `structure` prop; the view pane recomputes this and assigns it here so the
// AI-bridge poll + render effect read one shared, render-only snapshot.
export type StructureMirror = {
  atoms: { el: string; xyz: [number, number, number] }[]
  base: { i: number; j: number; order: number }[]
  lattice: number[][] | null
  n: number
} | null

class CatRenderState {
  // --- preset + global toggles -------------------------------------------
  preset = $state<Preset>(`default`)
  show_h = $state(true)
  show_cell = $state(false)
  // PBC ghost wrap-images: dim, bondless partner atoms across neighbour cells
  // for boundary atoms (RT12). Periodic structures only.
  pbc_wrap = $state(false)
  // OpenBabel-style auto bond-order perception (molecular only — not slabs).
  perceive_orders = $state<boolean>(false)
  // Drop bonds far longer than the covalent-radii sum (removes spurious
  // over-long bonds from distance-based connectivity).
  prune_long_bonds = $state<boolean>(false)
  hide_cross_cell_bonds = $state<boolean>(false)
  // Overlay atom indices (i/j) as an editing aid — off for clean figures.
  show_index = $state<boolean>(false)

  // --- the 17 dedicated live knobs (inherit-when-untouched gating) --------
  k_atom_scale = $state<Knob<number>>({ on: false, v: 2.5 })
  k_bond_width = $state<Knob<number>>({ on: false, v: 20 })
  k_atom_stroke_width = $state<Knob<number>>({ on: false, v: 8 })
  k_hue = $state<Knob<number>>({ on: false, v: 0.1 })
  k_light = $state<Knob<number>>({ on: false, v: 0.15 })
  k_sat = $state<Knob<number>>({ on: false, v: 0.15 })
  k_fog_strength = $state<Knob<number>>({ on: false, v: 1.2 })
  k_label_font_size = $state<Knob<number>>({ on: false, v: 40 })
  k_gradient = $state<Knob<boolean>>({ on: false, v: true })
  k_fog = $state<Knob<boolean>>({ on: false, v: true })
  k_bond_orders = $state<Knob<boolean>>({ on: false, v: true })
  k_bond_color_by_element = $state<Knob<boolean>>({ on: false, v: false })
  k_bond_gradient = $state<Knob<boolean>>({ on: false, v: false })
  k_atoms_above_bonds = $state<Knob<boolean>>({ on: false, v: false })
  k_bond_color = $state<Knob<string>>({ on: false, v: `#000000` })
  k_background = $state<Knob<string>>({ on: false, v: `#ffffff` })
  k_cell_color = $state<Knob<string>>({ on: false, v: `#808080` })

  // Advanced: raw JSON for ANY default.json knob not given a dedicated
  // control. Merged LAST onto the dedicated knobs.
  advanced_json = $state(``)

  // --- edit override layers (render-only, no main-viewer write-back) ------
  bond_overrides = $state<BondOverride[]>([])
  atom_overrides = $state<AtomOverride[]>([])

  // --- drag-rotate overlay (extra rotation applied AFTER PCA by core) -----
  // Accumulated intrinsic XYZ euler deltas (degrees) → style.drag_rotation.
  drag_rot = $state<[number, number, number]>([0, 0, 0])

  // --- shared structure mirror (view pane recomputes, both panes read) ----
  mirror = $state<StructureMirror>(null)

  /** Derived `{ map, err }` override projection — PURE, both panes read. */
  get overrides(): { map: Record<string, unknown>; err: string } {
    return build_overrides(
      {
        k_atom_scale: this.k_atom_scale,
        k_bond_width: this.k_bond_width,
        k_atom_stroke_width: this.k_atom_stroke_width,
        k_hue: this.k_hue,
        k_light: this.k_light,
        k_sat: this.k_sat,
        k_fog_strength: this.k_fog_strength,
        k_label_font_size: this.k_label_font_size,
        k_gradient: this.k_gradient,
        k_fog: this.k_fog,
        k_bond_orders: this.k_bond_orders,
        k_bond_color_by_element: this.k_bond_color_by_element,
        k_bond_gradient: this.k_bond_gradient,
        k_atoms_above_bonds: this.k_atoms_above_bonds,
        k_bond_color: this.k_bond_color,
        k_background: this.k_background,
        k_cell_color: this.k_cell_color,
      },
      this.advanced_json,
    )
  }

  /** Reset every dedicated knob + advanced JSON back to "inherit preset". */
  reset_to_preset() {
    for (const name of Object.keys(KNOB_KEYS) as KnobName[]) {
      ;(this[name] as Knob<unknown>).on = false
    }
    this.advanced_json = ``
  }

  /** Clear the drag-rotate overlay (back to pure PCA orientation). */
  reset_view() {
    this.drag_rot = [0, 0, 0]
  }
}

// Single shared instance — both panes `import { catrender_state }`.
export const catrender_state = new CatRenderState()
