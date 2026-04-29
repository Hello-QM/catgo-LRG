/**
 * Measurement State — extracted from Structure.svelte
 *
 * Manages measurement list, mode selection (distance/angle/dihedral),
 * continuous measurement mode state, and the measure menu UI toggle.
 *
 * Uses factory function pattern because $state must be created in component context.
 */

import type { Measurement } from '../index'
import { delete_measurement_from_list } from '../controllers/analysis-controller'

// ─── Factory ───

export function create_measurement_state() {
  // Measurement mode and menu
  let measure_mode: `distance` | `angle` | `dihedral` = $state(`distance`)
  let measure_menu_open = $state(false)

  // Multiple independent measurements
  let measurements = $state<Measurement[]>([])
  let selected_measurement_id = $state<string | null>(null)

  // Continuous measurement mode - when active, clicking atoms adds to current measurement
  let measure_mode_active = $state(false)
  let current_continuous_measurement_sites = $state<number[]>([])

  // Helper to delete a measurement and keep measured_sites in sync
  function delete_measurement(
    id: string,
    set_measured_sites: (sites: number[]) => void,
  ) {
    const result = delete_measurement_from_list(measurements, id)
    measurements = result.measurements
    selected_measurement_id = null
    if (result.clear_legacy) {
      set_measured_sites([])
    }
  }

  return {
    get measure_mode() { return measure_mode },
    set measure_mode(v: `distance` | `angle` | `dihedral`) { measure_mode = v },

    get measure_menu_open() { return measure_menu_open },
    set measure_menu_open(v: boolean) { measure_menu_open = v },

    get measurements() { return measurements },
    set measurements(v: Measurement[]) { measurements = v },

    get selected_measurement_id() { return selected_measurement_id },
    set selected_measurement_id(v: string | null) { selected_measurement_id = v },

    get measure_mode_active() { return measure_mode_active },
    set measure_mode_active(v: boolean) { measure_mode_active = v },

    get current_continuous_measurement_sites() { return current_continuous_measurement_sites },
    set current_continuous_measurement_sites(v: number[]) { current_continuous_measurement_sites = v },

    delete_measurement,
  }
}
