/**
 * Charge Labels State — extracted from Structure.svelte
 *
 * Manages per-atom charge label visibility, offsets, colors, and the
 * right-click color picker menu state.
 *
 * Uses factory function pattern because $state must be created in component context.
 *
 * NOTE: The prune $effect (which cleans stale charge label indices on structure change)
 * remains in Structure.svelte because it uses untrack() to avoid circular dependencies
 * and reads structure which is owned by the parent component.
 *
 * IMPORTANT: charge_label_offsets uses SvelteMap for reliable $derived tracking.
 */

import { SvelteMap } from 'svelte/reactivity'

// ─── Factory ───

export function create_charge_labels_state() {
  // Per-atom charge label state
  let visible_charge_labels = $state(new Set<number>())
  let charge_label_offsets = $state(new SvelteMap<number, [number, number]>())
  let charge_label_colors = $state(new Map<number, { text?: string; bg?: string }>())
  let charge_color_menu = $state<{ idx: number; x: number; y: number } | null>(null)

  return {
    get visible_charge_labels() { return visible_charge_labels },
    set visible_charge_labels(v: Set<number>) { visible_charge_labels = v },

    get charge_label_offsets() { return charge_label_offsets },
    set charge_label_offsets(v: SvelteMap<number, [number, number]>) { charge_label_offsets = v },

    get charge_label_colors() { return charge_label_colors },
    set charge_label_colors(v: Map<number, { text?: string; bg?: string }>) { charge_label_colors = v },

    get charge_color_menu() { return charge_color_menu },
    set charge_color_menu(v: { idx: number; x: number; y: number } | null) { charge_color_menu = v },
  }
}
