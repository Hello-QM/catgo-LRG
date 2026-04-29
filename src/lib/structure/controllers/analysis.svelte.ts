/**
 * Analysis Controller — extracted from Structure.svelte (P2-2)
 *
 * Manages state and logic for structure analysis tools:
 * - Symmetry analysis (moyo-wasm): analyze_cell, symmetry_data, wyckoff positions, orbits
 * - Analysis pane open/close and active tab
 * - Symmetry settings (precision, algorithm)
 *
 * NOT YET EXTRACTED (remain in Structure.svelte):
 * - Measurement tools: measure_mode, measure_menu_open, measurements[], measure_mode_active,
 *   current_continuous_measurement_sites[] (~lines 1056-1535)
 * - Electronic/Phase/MD analysis tab state (managed by child components)
 *
 * IMPORTANT:
 * - analyze_cell() is SYNCHRONOUS and blocks the main thread — keep the manual "Analyze" button
 *   pattern, never auto-compute
 * - Symmetry uses moyo-wasm: orbits[] uses INPUT cell indexing, wyckoffs[] uses STANDARDIZED
 *   cell indexing — NEVER mix them
 * - property_colors coordination coloring is NOT managed here (separate concern in Structure.svelte)
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 *
 * Dependencies:
 * - structure, symmetry_data accessed via getter/setter deps (symmetry_data is a $bindable prop
 *   in Structure.svelte, so it must be read/written via closures)
 */

import type { AnyStructure } from '$lib'
import type { MoyoDataset } from '@spglib/moyo-wasm'
type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | string
import {
  analyze_structure_symmetry,
  ensure_moyo_wasm_ready,
  default_sym_settings,
  type SymmetrySettings,
} from '$lib/symmetry'

// ─── Types ───

/** Dependencies interface — access parent component state via getter/setter closures */
export interface AnalysisDeps {
  get_structure: () => AnyStructure | undefined
  get_symmetry_data: () => MoyoDataset | null
  set_symmetry_data: (v: MoyoDataset | null) => void
}

// ─── Factory ───

/**
 * Create analysis controller — manages symmetry analysis state and callbacks.
 *
 * Usage:
 * ```ts
 * const analysis = create_analysis_controller({
 *   get_structure: () => structure,
 *   get_symmetry_data: () => symmetry_data,
 *   set_symmetry_data: (v) => { symmetry_data = v },
 * })
 * ```
 */
export function create_analysis_controller(deps: AnalysisDeps) {
  // ═══ Pane State ═══

  let analysis_pane_open = $state(false)
  let active_analysis_tab = $state<AnalysisTab>(`electronic`)

  // ═══ Symmetry State ═══
  // symmetry_data is owned by the parent (bindable prop) and accessed via deps.
  // The controller owns: run_id, error, loading, settings.

  let symmetry_run_id = 0
  let symmetry_error = $state<string | undefined>(undefined)
  let symmetry_loading = $state(false)
  let symmetry_settings = $state<SymmetrySettings>({ ...default_sym_settings })

  // ═══ Effects ═══

  // Clear stale symmetry data when structure changes
  $effect(() => {
    void deps.get_structure() // track structure dependency
    // Invalidate any pending computation and clear old results
    ++symmetry_run_id
    deps.set_symmetry_data(null)
    symmetry_error = undefined
    symmetry_loading = false
  })

  // ═══ Functions ═══

  /**
   * Run symmetry analysis manually — user clicks "Analyze" button.
   * This is intentionally NOT auto-computed because analyze_cell() blocks the main thread.
   */
  function run_symmetry_analysis() {
    const structure = deps.get_structure()
    if (!structure || !(`lattice` in structure) || symmetry_loading) return
    const current_structure = structure
    const current_settings = symmetry_settings
    const run_id = ++symmetry_run_id
    deps.set_symmetry_data(null)
    symmetry_error = undefined
    symmetry_loading = true

    ensure_moyo_wasm_ready()
      .then(() =>
        run_id === symmetry_run_id
          ? analyze_structure_symmetry(current_structure, current_settings)
          : null
      )
      .then((data) => {
        if (data && run_id === symmetry_run_id) {
          deps.set_symmetry_data(data)
        }
      })
      .catch((err) => {
        if (run_id === symmetry_run_id) {
          const msg = err?.message || String(err)
          if (msg.includes(`PrimitiveSymmetrySearchError`) || msg.includes(`SymmetrySearchError`)) {
            symmetry_error = undefined
            console.debug(`Symmetry analysis skipped (expected for slabs):`, msg)
          } else {
            symmetry_error = `Analysis failed: ${msg}`
            console.error(`Symmetry analysis failed:`, err)
          }
        }
      })
      .finally(() => {
        if (run_id === symmetry_run_id) symmetry_loading = false
      })
  }

  /**
   * Dismiss the symmetry error banner.
   */
  function dismiss_symmetry_error() {
    symmetry_error = undefined
  }

  // ═══ Public Interface ═══

  return {
    // ── Pane state ──
    get analysis_pane_open() { return analysis_pane_open },
    set analysis_pane_open(v: boolean) { analysis_pane_open = v },
    get active_analysis_tab() { return active_analysis_tab },
    set active_analysis_tab(v: AnalysisTab) { active_analysis_tab = v },

    // ── Symmetry state ──
    get symmetry_error() { return symmetry_error },
    get symmetry_loading() { return symmetry_loading },
    get symmetry_settings() { return symmetry_settings },
    set symmetry_settings(v: SymmetrySettings) { symmetry_settings = v },

    // ── Functions ──
    run_symmetry_analysis,
    dismiss_symmetry_error,
  }
}

/** Return type for the analysis controller */
export type AnalysisController = ReturnType<typeof create_analysis_controller>
